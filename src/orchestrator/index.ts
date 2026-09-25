/**
 * Orchestrator (Phase 5)
 *
 * Claude API를 실제로 호출하고 tool_use 루프를 통해 ERP Git/DB 도구를 사용합니다.
 * 최종 텍스트 답변과 references(CODE/DB)를 반환합니다.
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
} from "./types.js";
import type { Reference, CodeReference, DbReference } from "../config/types.js";

// ── 참조 추출 헬퍼 ────────────────────────────────────────

function extractReference(toolName: string, input: Record<string, unknown>): Reference | null {
  if (toolName === "erp_git__readFileRange") {
    return {
      type: "CODE",
      repo: String(input.repo ?? "erp"),  // tool의 repo 파라미터 값 사용
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

  async process(classifiedQuery: ClassifiedQuery): Promise<OrchestratorResult> {
    const startMs = Date.now();

    // 전체 타임아웃 레이스
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new OrchestratorError("TIMEOUT", "처리 시간 초과")),
        env.claudeTimeoutMs
      )
    );

    return Promise.race([this.processInternal(classifiedQuery, startMs), timeoutPromise]);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async continueSession(_sessionId: string, _userReply: string): Promise<OrchestratorResult> {
    throw new OrchestratorError("NOT_IMPLEMENTED", "멀티턴 세션은 아직 지원되지 않습니다.");
  }

  // ── 내부 처리 ────────────────────────────────────────────

  private async processInternal(
    classifiedQuery: ClassifiedQuery,
    startMs: number
  ): Promise<OrchestratorResult> {
    const { request } = classifiedQuery;

    // 시스템 프롬프트 구성
    const mockContextText = env.useMockContext
      ? buildMockContextText(request.memberId)
      : undefined;
    const systemPrompt = buildSystemPrompt(mockContextText);

    // 첫 번째 사용자 메시지
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

      // 최종 텍스트 수집
      for (const block of response.content) {
        if (block.type === "text") {
          finalAnswer = block.text;
        }
      }

      // 종료 조건
      if (response.stop_reason === "end_turn") {
        break;
      }

      if (response.stop_reason !== "tool_use") {
        // 예상치 못한 stop_reason
        break;
      }

      if (loop >= env.claudeMaxToolLoops) {
        throw new OrchestratorError(
          "MAX_TOOL_LOOPS_EXCEEDED",
          `도구 호출 상한(${env.claudeMaxToolLoops}회)에 도달했습니다.`
        );
      }

      // tool_use 블록 처리
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      // 어시스턴트 메시지 추가
      messages.push({ role: "assistant", content: response.content });

      // 각 도구 호출 실행
      const toolResults: ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        toolCallCount++;
        const input = toolUse.input as Record<string, unknown>;

        // 참조 추출
        const ref = extractReference(toolUse.name, input);
        if (ref) references.push(ref);

        // MCP 도구 호출
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

    const elapsedMs = Date.now() - startMs;

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
        elapsedMs,
      },
      processedAt: new Date().toISOString(),
    };
  }
}
