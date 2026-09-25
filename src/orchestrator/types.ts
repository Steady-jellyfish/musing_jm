import type { QueryType, Reference, ResponseMeta, SessionId } from "../config/types.js";
import type { ClassifiedQuery } from "../preprocess/types.js";

/** Orchestrator 처리 결과 */
export interface OrchestratorResult {
  sessionId: SessionId;
  queryType: QueryType;
  /** Claude의 최종 응답 텍스트 */
  answer: string;
  /** Claude가 참조한 소스/쿼리 목록 (Gateway로 전달되는 근거) */
  references: Reference[];
  /** 처리 메타 정보 */
  meta: ResponseMeta;
  processedAt: string; // ISO 8601
}

/** Orchestrator 처리 옵션 */
export interface ProcessOptions {
  /**
   * 이 요청에서 접근 허용된 저장소 ID 목록.
   * memberId + targetSystem으로 라우트 핸들러가 결정해서 전달합니다.
   */
  allowedRepos: string[];
  /**
   * 기존 캐시를 사용 중인 경우의 마지막 동기화 시각 (stale / syncing+캐시).
   * 설정되면 응답 meta.codeBaseAt에 포함됩니다.
   */
  codeBaseAt?: string;
}

/** Orchestrator 오류 — error.code가 HTTP 응답 error.code로 전달됩니다. */
export class OrchestratorError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

/** Orchestrator가 외부에 노출하는 인터페이스 */
export interface IOrchestrator {
  process(classifiedQuery: ClassifiedQuery, options: ProcessOptions): Promise<OrchestratorResult>;
  continueSession(sessionId: SessionId, userReply: string): Promise<OrchestratorResult>;
}
