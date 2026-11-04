/**
 * AgentRunner
 *
 * Agent SDK의 query()를 SSE 스트림으로 감싸 실행합니다.
 * - runStream(): SSE 이벤트를 yield하는 AsyncGenerator
 * - 도구 호출마다 trace 이벤트를 실시간 emit
 * - sessionId 재사용으로 채팅형 연속 대화 지원
 * - 취소: sessionStore.cancelRequest() → 내부 agentGen.return() → 스트림 종료
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

/** SSE 이벤트 유니온 타입 */
export type SseEvent =
  | { event: "connected"; data: { sessionId: string } }
  | { event: "token"; data: { text: string } }
  | { event: "trace"; data: TraceEntry }
  | {
      event: "clarification";
      data: { questions: ClarificationQuestion[]; type?: "LOGIC_REVIEW" | "ERROR_CAUSE" };
    }
  | {
      event: "done";
      data: {
        answer: string;
        references: Reference[];
        type?: "LOGIC_REVIEW" | "ERROR_CAUSE";
        usage: { elapsedMs: number; tokens?: number; filesRead?: number; dbQueries?: number };
      };
    }
  | { event: "error"; data: { sessionId: string; error: string } };

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

  /**
   * 질의를 처리하고 SSE 이벤트를 실시간으로 yield합니다.
   *
   * 이벤트 순서:
   *   connected → trace (반복) → clarification | done | error
   *
   * 채팅 연속 대화:
   *   sessionId를 재사용하면 Agent SDK의 resume으로 이전 대화 맥락을 이어갑니다.
   *   answers 없이 question만 보내면 follow-up 질문으로 처리됩니다.
   */
  async *runStream(req: ProcessRequest): AsyncGenerator<SseEvent> {
    const startMs = Date.now();

    // ── 중복 요청 차단 ────────────────────────────────────
    if (this.sessionStore.isRequestRunning(req.requestId)) {
      yield {
        event: "error",
        data: { sessionId: req.sessionId ?? "", error: "동일한 requestId로 이미 처리 중인 요청이 있습니다." },
      };
      return;
    }

    // ── 세션 관리 ─────────────────────────────────────────
    let session: SessionState | undefined;
    let sessionId: string;

    if (req.sessionId) {
      session = this.sessionStore.getSession(req.sessionId);
      if (!session) {
        yield {
          event: "error",
          data: { sessionId: req.sessionId, error: `세션을 찾을 수 없습니다: ${req.sessionId}` },
        };
        return;
      }
      sessionId = req.sessionId;
      // done 상태 세션에 follow-up이 오면 재활성화
      if (session.status === "done") {
        this.sessionStore.updateSession(sessionId, { status: "active" });
      }
    } else {
      sessionId = this.sessionStore.createSession(req.memberId, req.question);
    }

    // ── 연결 확인 이벤트 ──────────────────────────────────
    yield { event: "connected", data: { sessionId } };

    // ── 이벤트 큐 (백그라운드 → 스트림 브릿지) ──────────
    const queue: Array<SseEvent | null> = [];
    let waitResolve: (() => void) | null = null;
    let cancelled = false;

    const push = (event: SseEvent | null) => {
      if (cancelled) return;
      queue.push(event);
      waitResolve?.();
      waitResolve = null;
    };

    // ── 추적 상태 ─────────────────────────────────────────
    let pendingClarification: ClarificationQuestion[] | null = null;
    let queryType: "LOGIC_REVIEW" | "ERROR_CAUSE" | undefined = session?.queryType;
    const references: Reference[] = [];
    let filesRead = 0;
    let dbQueries = 0;
    let totalTokens = 0;

    // ── 커스텀 인프로세스 MCP 도구 ───────────────────────
    const setQueryTypeTool = tool(
      "set_query_type",
      "분석 시작 시 질의 유형을 선언합니다. LOGIC_REVIEW: 구현 확인, ERROR_CAUSE: 오류 원인 분석",
      { type: z.enum(["LOGIC_REVIEW", "ERROR_CAUSE"]) },
      async (args) => {
        queryType = args.type;
        push({
          event: "trace",
          data: {
            label: "유형 판별",
            detail: args.type === "LOGIC_REVIEW" ? "로직 문의" : "오류 원인 확인",
            elapsedMs: Date.now() - startMs,
          },
        });
        return { content: [{ type: "text" as const, text: `질의 유형: ${args.type}` }] };
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

    // ── PostToolUse Hook (실시간 trace 이벤트 emit) ───────
    const trackToolUse: HookCallback = async (hookInput) => {
      const inp = hookInput as {
        tool_name?: string;
        tool_input?: Record<string, unknown>;
      };
      const toolName = inp.tool_name ?? "";
      const toolInput = inp.tool_input ?? {};
      const elapsed = Date.now() - startMs;

      if (toolName.includes("readFileRange") || toolName.includes("read_file_range")) {
        filesRead++;
        const path = String(toolInput.path ?? "");
        const lineStart = Number(toolInput.lineStart ?? toolInput.line_start ?? 0);
        const locator = lineStart > 0 ? `${path}:${lineStart}` : path;
        if (locator) references.push({ locator, description: `파일 읽기: ${path}` });
        push({ event: "trace", data: { label: "저장소 탐색", detail: path || undefined, elapsedMs: elapsed } });
      } else if (
        toolName.includes("searchCode") ||
        toolName.includes("search_code") ||
        toolName.includes("listFiles") ||
        toolName.includes("list_files")
      ) {
        const pattern = String(toolInput.pattern ?? toolInput.query ?? "");
        push({ event: "trace", data: { label: "저장소 탐색", detail: pattern || undefined, elapsedMs: elapsed } });
      }

      if (toolName.includes("executeQuery") || toolName.includes("execute_query")) {
        dbQueries++;
        const table = String(toolInput.table ?? "");
        if (table) references.push({ locator: table, description: `DB 조회: ${table}` });
        push({ event: "trace", data: { label: "DB 조회", detail: table || undefined, elapsedMs: elapsed } });
      } else if (
        toolName.includes("describeTable") ||
        toolName.includes("describe_table") ||
        toolName.includes("listTables") ||
        toolName.includes("list_tables")
      ) {
        push({ event: "trace", data: { label: "DB 조회", elapsedMs: elapsed } });
      }

      return {};
    };

    // ── 프롬프트 구성 ─────────────────────────────────────
    // agentSessionId가 있으면 resume (되묻기 응답 or follow-up 모두 해당)
    const isResume = !!(session?.agentSessionId);
    let prompt: string;

    if (req.answers && Object.keys(req.answers).length > 0) {
      // 되묻기에 대한 답변
      const answerLines = Object.entries(req.answers)
        .map(([q, a]) => `  - "${q}" → ${a}`)
        .join("\n");
      prompt = `이전에 요청한 추가 정보에 대한 사용자 응답:\n${answerLines}\n\n원래 질문을 계속 분석해주세요.`;
    } else {
      // 신규 질문 또는 follow-up
      prompt = req.question;
    }

    // ── MCP 서버 설정 ─────────────────────────────────────
    const erpGitCmd = buildMcpCommand("src/mcp-servers/erp-git/index.ts");
    const erpDbCmd = buildMcpCommand("src/mcp-servers/erp-db/index.ts");

    const mcpServers: Record<
      string,
      { command: string; args: string[]; env?: Record<string, string> }
    > = {};

    if (process.env.HANWHA_ERP_GIT_URL) {
      mcpServers["erp-git"] = {
        ...erpGitCmd,
        env: { GIT_CACHE_DIR: env.gitCacheDir },
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
          ERP_DB_QUERY_TIMEOUT_MS: String(env.dbQueryTimeoutMs),
        },
      };
    }

    // ── 에이전트 백그라운드 실행 ──────────────────────────
    const runAgent = async () => {
      let agentGen: ReturnType<typeof query> | null = null;
      let agentSessionId: string | undefined;
      let finalAnswer = "";
      // content_block_delta 이벤트로 토큰을 이미 스트리밍했는지 추적
      let hasStreamedTokens = false;

      try {
        const queryOptions: Parameters<typeof query>[0] = {
          prompt,
          options: {
            systemPrompt: buildSystemPrompt(req.memberId),
            model: env.claudeModel,
            mcpServers: {
              ...mcpServers,
              "musing-core": customServer,
            },
            allowedTools: [
              "mcp__musing-core__set_query_type",
              "mcp__musing-core__request_clarification",
              "mcp__erp-git__listFiles",
              "mcp__erp-git__searchCode",
              "mcp__erp-git__readFileRange",
              "mcp__erp-db__listTables",
              "mcp__erp-db__describeTable",
              "mcp__erp-db__executeQuery",
            ],
            maxTurns: env.claudeMaxToolLoops + 1,
            hooks: {
              PostToolUse: [{ matcher: ".*", hooks: [trackToolUse] }],
            },
            ...(isResume && session?.agentSessionId
              ? { resume: session.agentSessionId }
              : {}),
          },
        };

        agentGen = query(queryOptions);
        // 취소 지원: agentGen을 sessionStore에 등록
        this.sessionStore.registerRequest(req.requestId, agentGen as AsyncGenerator<unknown>);

        for await (const message of agentGen) {
          if (message && typeof message === "object") {
            const msg = message as Record<string, unknown>;

            // ── Agent SDK 세션 ID 캡처 (resume에 사용) ────────
            if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
              agentSessionId = String(msg.session_id);
            }

            // ── [1순위] content_block_delta: 토큰 단위 실시간 스트리밍 ──
            // Agent SDK가 Claude API의 스트리밍 이벤트를 그대로 노출할 때 도달합니다.
            if (msg.type === "content_block_delta") {
              const delta = msg.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
                finalAnswer += delta.text;
                hasStreamedTokens = true;
                push({ event: "token", data: { text: delta.text } });
              }
            }

            // ── [2순위] assistant 완성 메시지 fallback ────────
            // content_block_delta가 없는 SDK 버전에서는 완성된 메시지 블록을 통째로 emit합니다.
            if (msg.type === "assistant" && !hasStreamedTokens) {
              const assistantMsg = msg.message as
                | { content?: Array<{ type: string; text?: string }> }
                | undefined;
              if (assistantMsg?.content) {
                for (const block of assistantMsg.content) {
                  if (block.type === "text" && typeof block.text === "string" && block.text) {
                    finalAnswer += block.text;
                    hasStreamedTokens = true;
                    push({ event: "token", data: { text: block.text } });
                  }
                }
              }
            }

            // ── [3순위] result 필드 fallback ─────────────────
            // 위 두 경로 모두에서 텍스트를 얻지 못했을 때만 사용합니다.
            if ("result" in msg) {
              if (!hasStreamedTokens) {
                finalAnswer = String(msg.result);
                if (finalAnswer) {
                  hasStreamedTokens = true;
                  push({ event: "token", data: { text: finalAnswer } });
                }
              } else if (!finalAnswer) {
                // 토큰은 스트리밍됐지만 누락된 경우 보정
                finalAnswer = String(msg.result);
              }
            }

            // ── 토큰 집계 ─────────────────────────────────────
            if (msg.usage) {
              const u = msg.usage as { input_tokens?: number; output_tokens?: number };
              totalTokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
            }
          }
        }

        // 세션 agentSessionId 저장 (다음 turn에 resume용)
        if (agentSessionId) {
          this.sessionStore.updateSession(sessionId, { agentSessionId });
        }

        // 최종 이벤트 emit
        if (pendingClarification) {
          this.sessionStore.updateSession(sessionId, {
            status: "waiting_input",
            queryType,
            pendingQuestions: pendingClarification,
          });
          push({
            event: "clarification",
            data: { questions: pendingClarification, type: queryType },
          });
        } else {
          this.sessionStore.updateSession(sessionId, { status: "done", queryType });
          push({
            event: "done",
            data: {
              answer: finalAnswer || "답변을 생성하지 못했습니다.",
              references,
              type: queryType,
              usage: {
                elapsedMs: Date.now() - startMs,
                tokens: totalTokens || undefined,
                filesRead,
                dbQueries,
              },
            },
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.sessionStore.updateSession(sessionId, { status: "failed" });
        push({ event: "error", data: { sessionId, error: errorMsg } });
      } finally {
        this.sessionStore.completeRequest(req.requestId);
        push(null); // 스트림 종료 신호
      }
    };

    // 백그라운드 실행 (await 없음 — 이벤트 큐로 통신)
    runAgent();

    // ── 이벤트 큐 → yield ─────────────────────────────────
    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            waitResolve = r;
          });
        }
        const event = queue.shift()!;
        if (event === null) break;
        yield event;
      }
    } finally {
      cancelled = true; // 클라이언트 연결 끊김 시 push 차단
    }
  }
}
