/** 회원사 식별자 */
export type MemberId = string;

/** 세션 ID (멀티턴 관리) */
export type SessionId = string;

/** 문의 유형 */
export type QueryType =
  | "fee_inquiry"       // 수수료 문의
  | "cms_error"         // CMS 오류
  | "contract_inquiry"  // 계약 조회
  | "pkg_su_calc"       // PKG_SU_CALC 관련
  | "issue_pattern"     // 이슈 패턴 분석
  | "unknown";          // 판별 실패

/** 지식베이스 카테고리 */
export type KbCategory =
  | "fee"
  | "cms"
  | "pkg_su_calc"
  | "issue_pattern";
