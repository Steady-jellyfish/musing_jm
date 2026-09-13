import type { MemberId, QueryType, SessionId } from "../config/types.js";
import type { ClassifiedQuery, ConversationTurn } from "../preprocess/types.js";

/** 각 MCP 서버에서 수집한 컨텍스트 */
export interface GatheredContext {
  knowledgeBase?: KnowledgeBaseContext;
  memberDb?: MemberDbContext;
  history?: HistoryContext;
}

export interface KnowledgeBaseContext {
  items: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
    relevanceScore: number;
  }>;
}

export interface MemberDbContext {
  memberId: MemberId;
  contractInfo?: Record<string, unknown>;
  orgInfo?: Record<string, unknown>;
  hrInfo?: Record<string, unknown>;
}

export interface HistoryContext {
  memberId: MemberId;
  recentCases: Array<{
    caseId: string;
    queryType: QueryType;
    resolvedAt: string;
    summary: string;
  }>;
}

/** Claude Code에 전달할 구조화된 프롬프트 */
export interface StructuredPrompt {
  /** 시스템 컨텍스트: 역할·규정 등 */
  systemContext: string;
  /** 사용자 요청 (원본 자연어 포함) */
  userRequest: string;
  /** MCP에서 수집한 컨텍스트 */
  context: GatheredContext;
  /** 처리 규정 (있을 경우) */
  processingRules?: string;
}

/** Orchestrator 처리 결과 (입출력 담당에게 반환) */
export interface OrchestratorResult {
  sessionId: SessionId;
  queryType: QueryType;
  /** Claude의 최종 응답 텍스트 */
  answer: string;
  /** 추가 확인이 필요한지 여부 (멀티턴 트리거) */
  requiresFollowUp: boolean;
  /** requiresFollowUp이 true일 때 Claude가 되묻는 질문 */
  followUpQuestion?: string;
  /** Claude 원본 응답 (디버깅용) */
  rawClaudeResponse: unknown;
  processedAt: string; // ISO 8601
}

/** Orchestrator가 외부에 노출하는 인터페이스 */
export interface IOrchestrator {
  process(
    classifiedQuery: ClassifiedQuery
  ): Promise<OrchestratorResult>;

  /** 멀티턴: 사용자 후속 응답 처리 */
  continueSession(
    sessionId: SessionId,
    userReply: string
  ): Promise<OrchestratorResult>;
}
