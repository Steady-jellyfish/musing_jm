/**
 * Orchestrator (Phase 5)
 *
 * Claude API를 실제로 호출하고 tool_use 루프를 통해 ERP Git/DB 도구를 사용합니다.
 * 최종 텍스트 답변과 references(CODE/DB)를 반환합니다.
 *
 * 저장소 접근 제어:
 * - ProcessOptions.allowedRepos에 없는 저장소 요청은 코드 레벨에서 차단합니다.
 * - 허용 저장소가 1개이면 Claude가 repo를 지정하지 않아도 자동으로 주입합니다.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ToolUseBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { env } from "../config/env.js";
import type { ClassifiedQuery } from "../preprocess/types.js";
import { mcpManager } from "./mcp-client.js";
import { buildSystemPrompt, buildUserMessage, buildMockContextText } from "./prompt-builder.js";
import {
  OrchestratorError,
  type OrchestratorResult,
  type IOrchestrator,
  type ProcessOptions,
} from "./types.js";
import type { Reference, CodeReference, DbReference } from "../config/types.js";

// ── 참조 추출 헬퍼 ────────────────────────────────────────

function extractReference(toolName: string, input: Record<string, unknown>): Reference | null {
  if (toolName === "erp_git__readFileRange") {
    return {
      type: "CODE",
      repo: String(input.repo ?? "erp"),  // tool의 repo 파라미터 값 사용 (자동 주입 포함)
      path: String(input.path ?? ""),
      lineStart: Number(input.lineStart ?? 0),
      lineEnd: Number(input.lineEnd ?? 0),
    } satisfies CodeReference;
  }
  if (toolName === "erp_db__executeQuery") {
    return {
      type: "DB",
      table: String(input.table ?? ""),
      query: String(input.query ?? ""),
    } satisfies DbReference;
  }
  return null;
}

// ── Orchestrator ──────────────────────────────────────────

export class Orchestrator implements IOrchestrator {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({ apiKey: env.anthropicApiKey });
  }

  /** MCP 서버 초기화. 앱 시작 시 한 번만 호출합니다. */
  async initialize(): Promise<void> {
    await mcpManager.initialize();
  }

  async process(
    classifiedQuery: ClassifiedQuery,
    options: ProcessOptions
  ): Promise<OrchestratorResult> {
    const startMs = Date.now();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new OrchestratorError("TIMEOUT", "처리 시간 초과")),
        env.claudeTimeoutMs
      )
    );

    return Promise.race([this.processInternal(classifiedQuery, options, startMs), timeoutPromise]);
  }

  async continueSession(_sessionId: string, _userReply: string): Promise<OrchestratorResult> {
    throw new OrchestratorError("NOT_IMPLEMENTED", "멀티턴 세션은 아직 지원되지 않습니다.");
  }

  // ── 내부 처리 ────────────────────────────────────────────

  private async processInternal(
    classifiedQuery: ClassifiedQuery,
    options: ProcessOptions,
    startMs: number
  ): Promise<OrchestratorResult> {
    const { request } = classifiedQuery;

    const mockContextText = env.useMockContext
      ? buildMockContextText(request.memberId)
      : undefined;
    const systemPrompt = buildSystemPrompt(mockContextText);

    const messages: MessageParam[] = [
      { role: "user", content: buildUserMessage(classifiedQuery) },
    ];

    const tools = mcpManager.getTools();
    const references: Reference[] = [];
    let toolCallCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalAnswer = "";

    // tool_use 루프
    for (let loop = 0; loop <= env.claudeMaxToolLoops; loop++) {
      let response: Awaited<ReturnType<typeof this.anthropic.messages.create>>;
      try {
        response = await this.anthropic.messages.create({
          model: env.claudeModel,
          max_tokens: 4096,
          system: systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
          messages,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new OrchestratorError("CLAUDE_API_ERROR", `Claude API 호출 실패: ${msg}`);
      }

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      for (const block of response.content) {
        if (block.type === "text") finalAnswer = block.text;
      }

      if (response.stop_reason === "end_turn") break;
      if (response.stop_reason !== "tool_use") break;

      if (loop >= env.claudeMaxToolLoops) {
        throw new OrchestratorError(
          "MAX_TOOL_LOOPS_EXCEEDED",
          `도구 호출 상한(${env.claudeMaxToolLoops}회)에 도달했습니다.`
        );
      }

      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      messages.push({ role: "assistant", content: response.content });

      const toolResults: ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const input = toolUse.input as Record<string, unknown>;

        // ── erp-git 도구: 허용 저장소 검증 및 자동 주입 ──
        if (toolUse.name.startsWith("erp_git__")) {
          const requestedRepo = input.repo as string | undefined;

          if (!requestedRepo && options.allowedRepos.length === 1) {
            // 허용 저장소 1개이고 미지정: 자동 주입 (Claude가 별도 지정 불필요)
            input.repo = options.allowedRepos[0];
          } else if (requestedRepo && !options.allowedRepos.includes(requestedRepo)) {
            // 허용 목록 밖 접근: MCP 호출 없이 즉시 거부
            toolCallCount++;
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content:
                `접근 거부: 저장소 '${requestedRepo}'는 이 요청에서 접근할 수 없습니다. ` +
                `허용 저장소: ${options.allowedRepos.join(", ")}`,
              is_error: true,
            });
            continue;
          }
        }

        // ── 참조 추출 (repo 주입 이후에 실행) ──
        const ref = extractReference(toolUse.name, input);
        if (ref) references.push(ref);

        toolCallCount++;
        const result = await mcpManager.callTool(toolUse.name, input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.text,
          is_error: result.isError,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    return {
      sessionId: request.requestId,
      queryType: classifiedQuery.queryType,
      answer: finalAnswer || "답변을 생성하지 못했습니다.",
      references,
      meta: {
        model: env.claudeModel,
        toolCallCount,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        elapsedMs: Date.now() - startMs,
        codeBaseAt: options.codeBaseAt,
      },
      processedAt: new Date().toISOString(),
    };
  }
}
