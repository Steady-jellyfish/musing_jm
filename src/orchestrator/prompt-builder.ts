import type { GatheredContext, StructuredPrompt } from "./types.js";
import type { ClassifiedQuery } from "../preprocess/types.js";

/**
 * 수집된 컨텍스트와 분류 결과를 Claude Code에 적합한
 * 구조화된 프롬프트로 조립합니다.
 */
export function buildStructuredPrompt(
  classified: ClassifiedQuery,
  context: GatheredContext
): StructuredPrompt {
  const { queryType, rawInquiry } = classified;

  const systemContext = buildSystemContext(queryType);
  const userRequest = buildUserRequest(rawInquiry.rawText, classified);

  return {
    systemContext,
    userRequest,
    context,
    processingRules: getProcessingRules(queryType),
  };
}

function buildSystemContext(queryType: string): string {
  return [
    "당신은 Musing 사내 업무 처리 엔진의 일부로, 회원사의 업무 문의를 처리합니다.",
    `현재 처리 중인 문의 유형: ${queryType}`,
    "아래의 컨텍스트(지식베이스, 회원사 DB, 처리 이력)를 참고하여 정확하게 답변하세요.",
    "판단이 불확실하거나 추가 정보가 필요한 경우, 되묻는 질문을 생성하세요.",
  ].join("\n");
}

function buildUserRequest(rawText: string, classified: ClassifiedQuery): string {
  return [
    `[원본 문의]`,
    rawText,
    ``,
    `[회원사 ID] ${classified.rawInquiry.memberId}`,
    `[판별된 유형] ${classified.queryType} (신뢰도: ${(classified.confidence * 100).toFixed(0)}%)`,
    `[매칭 키워드] ${classified.matchedKeywords.join(", ")}`,
  ].join("\n");
}

function getProcessingRules(queryType: string): string {
  const rules: Record<string, string> = {
    fee_inquiry: "수수료 정책 문서 기준으로 답변. 정책 변경 이력 확인 필수.",
    cms_error: "CMS 오류 코드 확인 후 처리 절차 안내. 긴급 여부 판단 포함.",
    contract_inquiry: "계약 정보는 조회만 가능. 수정 요청은 담당자 연결 필요.",
    pkg_su_calc: "PKG_SU_CALC 로직 기준으로 계산 검증. 수식 근거 명시.",
    issue_pattern: "유사 이슈 이력 참조. 반복 패턴이면 근본 원인 분석 제안.",
    unknown: "유형 판별 실패. 추가 정보 요청 후 재분류.",
  };
  return rules[queryType] ?? "";
}
