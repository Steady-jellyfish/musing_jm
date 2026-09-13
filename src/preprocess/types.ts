import type { MemberId, QueryType, SessionId } from "../config/types.js";

/** 입출력 담당(한상민)이 넘겨주는 원시 입력 */
export interface RawInquiry {
  /** 회원사 식별자 */
  memberId: MemberId;
  /** 사용자 원시 자연어 */
  rawText: string;
  /** 멀티턴 세션 ID. 첫 문의면 undefined */
  sessionId?: SessionId;
  /** 이전 대화 기록 (멀티턴) */
  previousTurns?: ConversationTurn[];
}

/** 단일 대화 턴 */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string; // ISO 8601
}

/** 유형 판별 결과 */
export interface ClassifiedQuery {
  queryType: QueryType;
  /** 판별 신뢰도 0~1 */
  confidence: number;
  /** 판별 근거 키워드 */
  matchedKeywords: string[];
  rawInquiry: RawInquiry;
}
