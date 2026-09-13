import { randomUUID } from "crypto";
import type {
  GatheredContext,
  IOrchestrator,
  OrchestratorResult,
  StructuredPrompt,
} from "./types.js";
import type { ClassifiedQuery } from "../preprocess/types.js";
import type { SessionId } from "../config/types.js";
import { buildStructuredPrompt } from "./prompt-builder.js";

/**
 * 오케스트레이터 구현체
 *
 * TODO: 실제 MCP 클라이언트 연결 및 Claude API 호출 구현
 */
export class Orchestrator implements IOrchestrator {
  async process(classifiedQuery: ClassifiedQuery): Promise<OrchestratorResult> {
    const sessionId = randomUUID();

    // Step 1: 컨텍스트 수집 (MCP 서버 호출)
    const context = await this.gatherContext(classifiedQuery);

    // Step 2: 구조화된 프롬프트 조립
    const prompt = buildStructuredPrompt(classifiedQuery, context);

    // Step 3: Claude Code 호출 (TODO: 실제 MCP 클라이언트로 교체)
    const claudeResponse = await this.callClaude(prompt);

    // Step 4: 결과 파싱 및 반환
    return this.parseResult(sessionId, classifiedQuery.queryType, claudeResponse);
  }

  async continueSession(
    sessionId: SessionId,
    userReply: string
  ): Promise<OrchestratorResult> {
    // TODO: 세션 스토어에서 이전 컨텍스트 복원 후 이어서 처리
    throw new Error(`continueSession(${sessionId}, "${userReply}") - not yet implemented`);
  }

  /** MCP 서버들(knowledge-base, member-db, history)에서 컨텍스트 수집 */
  private async gatherContext(
    classified: ClassifiedQuery
  ): Promise<GatheredContext> {
    // TODO: 실제 MCP 클라이언트 호출로 교체
    // 현재는 각 MCP 서버가 독립 프로세스로 실행되므로,
    // Claude Code 내에서 tool call을 통해 간접 호출되는 구조
    console.error("[orchestrator] gatherContext - mock mode");

    return {
      knowledgeBase: {
        items: [
          {
            id: "kb-mock-001",
            category: classified.queryType,
            title: "(mock) 관련 지식베이스 항목",
            content: "실제 KB 데이터가 여기에 들어옵니다.",
            relevanceScore: 0.9,
          },
        ],
      },
      memberDb: {
        memberId: classified.rawInquiry.memberId,
        contractInfo: { status: "active", plan: "enterprise" },
      },
      history: {
        memberId: classified.rawInquiry.memberId,
        recentCases: [],
      },
    };
  }

  /** Claude API / MCP 호출 (mock) */
  private async callClaude(prompt: StructuredPrompt): Promise<string> {
    // TODO: Anthropic SDK 또는 MCP를 통한 Claude 호출로 교체
    console.error("[orchestrator] callClaude - mock mode");
    console.error("[orchestrator] prompt:", JSON.stringify(prompt, null, 2));

    return JSON.stringify({
      answer: "(mock) Claude 응답이 여기에 들어옵니다.",
      requiresFollowUp: false,
    });
  }

  private parseResult(
    sessionId: SessionId,
    queryType: ClassifiedQuery["queryType"],
    claudeRaw: string
  ): OrchestratorResult {
    let parsed: { answer: string; requiresFollowUp: boolean; followUpQuestion?: string };
    try {
      parsed = JSON.parse(claudeRaw);
    } catch {
      parsed = { answer: claudeRaw, requiresFollowUp: false };
    }

    return {
      sessionId,
      queryType,
      answer: parsed.answer,
      requiresFollowUp: parsed.requiresFollowUp ?? false,
      followUpQuestion: parsed.followUpQuestion,
      rawClaudeResponse: parsed,
      processedAt: new Date().toISOString(),
    };
  }
}
