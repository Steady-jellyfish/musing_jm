import type { ClassifiedQuery, InquiryRequest } from "./types.js";
import type { QueryType } from "../config/types.js";

const VALID_QUERY_TYPES: QueryType[] = ["LOGIC_CHECK", "REASON_CHECK"];

/**
 * 문의 유형 검증기
 * Gateway가 전달한 queryType을 확인하고, 유효하지 않으면 기본값으로 보정합니다.
 *
 * Phase 1: 기본 검증만 수행
 * Phase 2: memberId + requester 권한 확인 추가 예정
 */
export function classifyQuery(request: InquiryRequest): ClassifiedQuery {
  const isValid = VALID_QUERY_TYPES.includes(request.queryType);

  return {
    queryType: isValid ? request.queryType : "LOGIC_CHECK",
    confidence: isValid ? 1.0 : 0.5,
    request,
  };
}
