import type { ClassifiedQuery, RawInquiry } from "./types.js";
import type { QueryType } from "../config/types.js";

/**
 * 자연어 유형 판별기 (현재: 키워드 기반 mock)
 * 추후 Claude API 호출 또는 경량 분류 모델로 교체 예정
 */
export async function classifyQuery(
  rawInquiry: RawInquiry
): Promise<ClassifiedQuery> {
  const text = rawInquiry.rawText.toLowerCase();

  const rules: Array<{
    type: QueryType;
    keywords: string[];
  }> = [
    { type: "fee_inquiry", keywords: ["수수료", "fee", "요금", "청구"] },
    { type: "cms_error", keywords: ["cms", "오류", "에러", "error", "장애"] },
    { type: "contract_inquiry", keywords: ["계약", "contract", "협약", "갱신"] },
    { type: "pkg_su_calc", keywords: ["pkg", "su_calc", "패키지", "계산"] },
    { type: "issue_pattern", keywords: ["패턴", "반복", "이슈", "issue"] },
  ];

  for (const rule of rules) {
    const matched = rule.keywords.filter((kw) => text.includes(kw));
    if (matched.length > 0) {
      return {
        queryType: rule.type,
        confidence: Math.min(0.5 + matched.length * 0.15, 0.95),
        matchedKeywords: matched,
        rawInquiry,
      };
    }
  }

  return {
    queryType: "unknown",
    confidence: 0,
    matchedKeywords: [],
    rawInquiry,
  };
}
