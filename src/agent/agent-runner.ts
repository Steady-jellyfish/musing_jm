/**
 * AgentRunner
 *
 * @anthropic-ai/claude-agent-sdk 의 query() 를 사용해 ERP 분석 에이전트를 실행합니다.
 *
 * 변경 전 (Anthropic SDK 직접 호출):
 *   - anthropic.messages.create() + 수동 tool_use 루프
 *   - McpClientManager가 서브프로세스 MCP 서버를 직접 관리
 *
 * 변경 후 (Agent SDK):
 *   - query()가 tool_use 루프를 자동 처리
 *   - mcpServers 옵션으로 MCP 서버 연결을 Agent SDK에 위임
 *   - hooks 로 도구 호출을 추적 → references / trace 생성
 *   - 커스텀 인프로세스 MCP 서버로 set_query_type / request_clarification 제공
 */

import {
  query,
  tool,
  createSdkMcpServer,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { env } from "../config/env.js";
import type {
  SessionStore,
  SessionState,
  ClarificationQuestion,
  TraceEntry,
} from "./session-store.js";

// ── 공개 타입 ──────────────────────────────────────────────

export interface ProcessRequest {
  question: string;
  memberId: string;
  sessionId?: string;
  answers?: Record<string, string>;
  requestId: string;
}

export interface Reference {
  locator: string;
  description: string;
}

export interface ProcessResult {
  status: "done" | "waiting_input" | "failed";
  sessionId: string;
  type?: "LOGIC_REVIEW" | "ERROR_CAUSE";

  // status === "done"
  answer?: string;
  references?: Reference[];
  usage?: {
    elapsedMs: number;
    tokens?: number;
    filesRead?: number;
    dbQueries?: number;
  };

  // status === "waiting_input"
  questions?: ClarificationQuestion[];

  // 공통
  trace: TraceEntry[];

  // status === "failed"
  error?: string;
}

// ── 시스템 프롬프트 ────────────────────────────────────────

function buildSystemPrompt(memberId: string): string {
  return `당신은 회원사(${memberId})의 ERP 시스템을 분석하는 전문 에이전트입니다.

[필수 초기 작업]
분석을 시작하기 전에 반드시 set_query_type 도구를 호출해 질의 유형을 선언하세요.
  - LOGIC_REVIEW: 특정 로직/기능이 어떻게 구현되어 있는지 확인하는 질문
  - ERROR_CAUSE: 계산값 오류, 0원, 미반영 등 원인을 찾는 질문

[분석 절차]
1. set_query_type으로 유형 선언
2. 질의가 모호하거나 추가 정보가 필요하면 request_clarification을 호출하고 분석을 중단하세요
3. ERP Git / DB 도구로 근거를 찾아 답변하세요

[도구 사용 원칙]
- 코드 분석: searchCode 또는 listFiles 로 탐색 → readFileRange 로 내용 확인
- 데이터 분석: describeTable → executeQuery 순서로 진행
- 모든 주장은 파일 경로:줄번호 또는 테이블명으로 근거를 제시하세요
- 추측 금지. 소스/DB 근거가 없으면 명확히 밝히세요

[답변 형식]
- 핵심 결론을 먼저, 세부 근거를 뒤에
- 코드 참조: 파일경로:줄번호 형식
- DB 참조: 테이블명 또는 컬럼명 명시`;
}

// ── Windows 호환 명령어 ────────────────────────────────────

function buildMcpCommand(scriptPath: string): { command: string; args: string[] } {
  const isWin = process.platform === "win32";
  return isWin
    ? { command: "cmd", args: ["/c", "npx", "tsx", scriptPath] }
    : { command: "npx", args: ["tsx", scriptPath] };
}

// ── AgentRunner ───────────────────────────────────────────

export class AgentRunner {
  constructor(private readonly sessionStore: SessionStore) {}

  async run(req: ProcessRequest): Promise<ProcessResult> {
    const startMs = Date.now();

    // ── 중복 요청 차단 ────────────────────────────────────
    if (this.sessionStore.isRequestRunning(req.requestId)) {
      return {
        status: "failed",
        sessionId: req.sessionId ?? "",
        trace: [],
        error: "동일한 requestId로 이미 처리 중인 요청이 있습니다.",
      };
    }

    // ── 세션 관리 ─────────────────────────────────────────
    let session: SessionState | undefined;
    let sessionId: string;

    if (req.sessionId) {
      session = this.sessionStore.getSession(req.sessionId);
      if (!session) {
        return {
          status: "failed",
          sessionId: req.sessionId,
          trace: [],
          error: `세션을 찾을 수 없습니다: ${req.sessionId}`,
        };
      }
      sessionId = req.sessionId;
    } else {
      sessionId = this.sessionStore.createSession(req.memberId, req.question);
    }

    // ── 추적 상태 (클로저) ────────────────────────────────
    let pendingClarification: ClarificationQuestion[] | null = null;
    let queryType: "LOGIC_REVIEW" | "ERROR_CAUSE" | undefined =
      session?.queryType;
    const references: Reference[] = [];
    const tracePhases = {
      classify: undefined as TraceEntry | undefined,
      gitSearch: { count: 0, details: [] as string[], lastMs: 0 },
      dbQuery: { count: 0, details: [] as string[], lastMs: 0 },
    };
    let filesRead = 0;
    let dbQueries = 0;

    // ── 커스텀 인프로세스 MCP 서버 ────────────────────────
    const setQueryTypeTool = tool(
      "set_query_type",
      "분석 시작 시 질의 유형을 선언합니다. LOGIC_REVIEW: 구현 확인, ERROR_CAUSE: 오류 원인 분석",
      { type: z.enum(["LOGIC_REVIEW", "ERROR_CAUSE"]) },
      async (args) => {
        queryType = args.type;
        tracePhases.classify = {
          label: "유형 판별",
          detail: args.type === "LOGIC_REVIEW" ? "로직 문의" : "오류 원인 확인",
          elapsedMs: Date.now() - startMs,
        };
        return {
          content: [{ type: "text" as const, text: `질의 유형: ${args.type}` }],
        };
      }
    );

    const requestClarificationTool = tool(
      "request_clarification",
      "질의가 모호할 때 사용자에게 추가 정보를 요청합니다. 호출 후 반드시 분석을 중단하세요.",
      {
        questions: z.array(
          z.object({
            question: z.string().describe("사용자에게 물어볼 질문"),
            options: z.array(
              z.object({
                label: z.string().describe("선택지 라벨"),
                description: z.string().describe("선택지 설명"),
              })
            ),
            multiSelect: z.boolean().describe("복수 선택 허용 여부"),
          })
        ),
      },
      async (args) => {
        pendingClarification = args.questions as ClarificationQuestion[];
        return {
          content: [
            {
              type: "text" as const,
              text: "사용자에게 추가 정보를 요청했습니다. 응답이 올 때까지 분석을 중단하세요.",
            },
          ],
        };
      }
    );

    const customServer = createSdkMcpServer({
      name: "musing-core",
      tools: [setQueryTypeTool, requestClarificationTool],
    });

    // ── 도구 호출 추적 Hook ───────────────────────────────
    const trackToolUse: HookCallback = async (hookInput) => {
      const inp = hookInput as {
        tool_name?: string;
        tool_input?: Record<string, unknown>;
      };
      const toolName = inp.tool_name ?? "";
      const toolInput = inp.tool_input ?? {};
      const elapsed = Date.now() - startMs;

      // Git 도구
      if (
        toolName.includes("readFileRange") ||
        toolName.includes("read_file_range")
      ) {
        filesRead++;
        const path = String(toolInput.path ?? "");
        const lineStart = Number(toolInput.lineStart ?? toolInput.line_start ?? 0);
        const locator = lineStart > 0 ? `${path}:${lineStart}` : path;
        if (locator) {
          references.push({ locator, description: `파일 읽기: ${path}` });
        }
        tracePhases.gitSearch.count++;
        tracePhases.gitSearch.lastMs = elapsed;
        if (path) tracePhases.gitSearch.details.push(path);
      } else if (
        toolName.includes("searchCode") ||
        toolName.includes("search_code") ||
        toolName.includes("listFiles") ||
        toolName.includes("list_files")
      ) {
        tracePhases.gitSearch.count++;
        tracePhases.gitSearch.lastMs = elapsed;
        const pattern = String(toolInput.pattern ?? "");
        if (pattern) tracePhases.gitSearch.details.push(pattern);
      }

      // DB 도구
      if (
        toolName.includes("executeQuery") ||
        toolName.includes("execute_query")
      ) {
        dbQueries++;
        const table = String(toolInput.table ?? "");
        if (table) {
          references.push({ locator: table, description: `DB 조회: ${table}` });
        }
        tracePhases.dbQuery.count++;
        tracePhases.dbQuery.lastMs = elapsed;
        if (table) tracePhases.dbQuery.details.push(table);
      } else if (
        toolName.includes("describeTable") ||
        toolName.includes("describe_table") ||
        toolName.includes("listTables") ||
        toolName.includes("list_tables")
      ) {
        tracePhases.dbQuery.count++;
        tracePhases.dbQuery.lastMs = elapsed;
      }

      return {};
    };

    // ── 프롬프트 구성 ─────────────────────────────────────
    let prompt: string;
    const isResume = !!(req.sessionId && req.answers);

    if (isResume && req.answers) {
      const answerLines = Object.entries(req.answers)
        .map(([q, a]) => `  - "${q}" → ${a}`)
        .join("\n");
      prompt = `이전에 요청한 추가 정보에 대한 사용자 응답:\n${answerLines}\n\n원래 질문을 계속 분석해주세요.`;
    } else {
      prompt = req.question;
    }

    // ── MCP 서버 설정 ─────────────────────────────────────
    const erpGitCmd = buildMcpCommand("src/mcp-servers/erp-git/index.ts");
    const erpDbCmd = buildMcpCommand("src/mcp-servers/erp-db/index.ts");

    const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};

    if (process.env.ERP_GIT_URL) {
      mcpServers["erp-git"] = {
        ...erpGitCmd,
        env: { ERP_GIT_CACHE_DIR: env.erpGitCacheDir },
      };
    }

    if (env.erpDb.host && env.erpDb.name && env.erpDb.user) {
      mcpServers["erp-db"] = {
        ...erpDbCmd,
        env: {
          ERP_DB_HOST: env.erpDb.host,
          ERP_DB_PORT: String(env.erpDb.port),
          ERP_DB_NAME: env.erpDb.name,
          ERP_DB_USER: env.erpDb.user,
          ERP_DB_PASSWORD: env.erpDb.password,
          ERP_DB_QUERY_TIMEOUT_MS: String(env.erpDb.queryTimeoutMs),
        },
      };
    }

    // ── Agent SDK 실행 ────────────────────────────────────
    let agentSessionId: string | undefined;
    let finalAnswer = "";
    let agentFailed = false;
    let agentError = "";

    const queryOptions: Parameters<typeof query>[0] = {
      prompt,
      options: {
        systemPrompt: buildSystemPrompt(req.memberId),
        model: env.claudeModel,
        mcpServers: {
          ...mcpServers,
          "musing-core": customServer,
        },
        // Agent SDK 기본 도구는 허용하지 않음 (ERP MCP 도구만 사용)
        allowedTools: [] as string[],
        maxTurns: env.claudeMaxToolLoops + 1,
        hooks: {
          PostToolUse: [{ matcher: ".*", hooks: [trackToolUse] }],
        },
        ...(isResume && session?.agentSessionId
          ? { resume: session.agentSessionId }
          : {}),
      },
    };

    const gen = query(queryOptions);

    // 제너레이터를 sessionStore에 등록 (취소 지원)
    this.sessionStore.registerRequest(req.requestId, gen as AsyncGenerator<unknown>);

    try {
      for await (const message of gen) {
        // init: Agent SDK 세션 ID 캡처
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          (message as { type: string }).type === "system" &&
          "subtype" in message &&
          (message as { subtype: string }).subtype === "init" &&
          "session_id" in message
        ) {
          agentSessionId = String((message as { session_id: string }).session_id);
        }

        // 최종 결과 캡처
        if (message && typeof message === "object" && "result" in message) {
          finalAnswer = String((message as { result: string }).result);
        }
      }
    } catch (err) {
      agentFailed = true;
      agentError = err instanceof Error ? err.message : String(err);
    } finally {
      this.sessionStore.completeRequest(req.requestId);
    }

    // ── trace 조립 ────────────────────────────────────────
    const totalElapsed = Date.now() - startMs;
    const trace: TraceEntry[] = [];

    if (tracePhases.classify) {
      trace.push(tracePhases.classify);
    } else if (queryType) {
      trace.push({
        label: "유형 판별",
        detail: queryType === "LOGIC_REVIEW" ? "로직 문의" : "오류 원인 확인",
        elapsedMs: 0,
      });
    }

    if (tracePhases.gitSearch.count > 0) {
      trace.push({
        label: "저장소 탐색",
        detail: `${tracePhases.gitSearch.count}개 파일`,
        elapsedMs: tracePhases.gitSearch.lastMs,
      });
    }

    if (tracePhases.dbQuery.count > 0) {
      trace.push({
        label: "DB 조회",
        detail: `${tracePhases.dbQuery.count}건`,
        elapsedMs: tracePhases.dbQuery.lastMs,
      });
    }

    if (!agentFailed && !pendingClarification) {
      trace.push({ label: "응답 작성", elapsedMs: totalElapsed });
    }

    // ── 세션 상태 업데이트 ────────────────────────────────
    if (agentSessionId) {
      this.sessionStore.updateSession(sessionId, { agentSessionId });
    }

    // ── 결과 반환 ─────────────────────────────────────────

    if (agentFailed) {
      this.sessionStore.updateSession(sessionId, { status: "failed" });
      return {
        status: "failed",
        sessionId,
        type: queryType,
        trace,
        error: agentError,
      };
    }

    if (pendingClarification) {
      this.sessionStore.updateSession(sessionId, {
        status: "waiting_input",
        queryType,
        pendingQuestions: pendingClarification,
        pendingTrace: trace,
      });
      return {
        status: "waiting_input",
        sessionId,
        type: queryType,
        questions: pendingClarification,
        trace,
      };
    }

    this.sessionStore.updateSession(sessionId, {
      status: "done",
      queryType,
    });

    return {
      status: "done",
      sessionId,
      type: queryType,
      answer: finalAnswer || "답변을 생성하지 못했습니다.",
      references,
      trace,
      usage: {
        elapsedMs: totalElapsed,
        filesRead,
        dbQueries,
      },
    };
  }
}
