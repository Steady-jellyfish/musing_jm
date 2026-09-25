import type { MemberId, QueryType, SessionId } from "../config/types.js";

/** Gateway로부터 수신하는 HTTP 요청 (1차 필터링 완료된 정제 데이터) */
export interface InquiryRequest {
  /** Gateway 발급 요청 ID */
  requestId: string;
  /** 회원사 식별자 */
  memberId: MemberId;
  /**
   * 대상 시스템 (예: "ERP", "CMS").
   * memberId + targetSystem 조합으로 참조할 Git 저장소를 결정합니다.
   */
  targetSystem: string;
  /** 문의 유형 (Gateway가 1차 판별) */
  queryType: QueryType;
  /** 정제된 질의 */
  question: string;
  /** 요청자 정보 (권한 확인용) */
  requester: {
    userId: string;
    role: string;
  };
  /** 화면 컨텍스트 (선택) */
  context?: {
    screenId?: string;
    menuName?: string;
    keyValues?: Record<string, string>;
  };
}

/** 유형 검증·보정 결과 */
export interface ClassifiedQuery {
  queryType: QueryType;
  /** 검증 신뢰도 0~1 */
  confidence: number;
  /** 원본 요청 */
  request: InquiryRequest;
}

// 하위 호환을 위해 유지 (dev-runner.ts에서 사용)
export interface RawInquiry {
  memberId: MemberId;
  rawText: string;
  sessionId?: SessionId;
}
