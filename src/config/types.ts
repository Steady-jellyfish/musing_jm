/** 회원사 식별자 */
export type MemberId = string;

/** 세션 ID (멀티턴 관리) */
export type SessionId = string;

/** 문의 유형 (Gateway가 1차 판별해서 전달) */
export type QueryType =
  | "LOGIC_CHECK"   // 로직 확인
  | "REASON_CHECK"; // 사유 확인

/** 지식베이스 카테고리 */
export type KbCategory =
  | "fee"
  | "cms"
  | "pkg_su_calc"
  | "issue_pattern";

/** 응답 상태 */
export type ResponseStatus = "SUCCESS" | "FAILED" | "REJECTED";

/** 참조 정보: 코드 */
export interface CodeReference {
  type: "CODE";
  repo: string;
  path: string;
  lineStart: number;
  lineEnd: number;
}

/** 참조 정보: DB 쿼리 */
export interface DbReference {
  type: "DB";
  table: string;
  query: string;
}

export type Reference = CodeReference | DbReference;

/** 처리 메타 정보 */
export interface ResponseMeta {
  model: string;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}
