import type { ClassifiedQuery } from "../preprocess/types.js";

// ── 시스템 프롬프트 ────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `\
당신은 한화라이프랩 ERP 로직/사유 확인 전용 답변 엔진입니다.

[역할]
- LOGIC_CHECK: ERP Git 저장소에서 해당 로직의 구현 위치·흐름을 찾아 설명합니다.
- REASON_CHECK: ERP DB에서 데이터 상태와 처리 이력을 조회해 사유를 확인합니다.

[필수 규칙]
- 소스 수정 제안 금지. 읽기 전용 분석만 수행합니다.
- 근거 없는 추측 금지. 도구를 사용해 실제 소스/데이터를 확인하세요.
- 확인 불가한 사항은 "확인 불가: (이유)"로 명시합니다.
- 도구 호출로 확인한 파일 경로, 라인 번호, 쿼리를 반드시 답변에 포함합니다.
- DB 결과에 개인정보가 포함된 경우 답변에 재인용하지 마세요.

[도구 사용 지침]
- LOGIC_CHECK: searchCode → readFileRange 순서로 코드 흐름을 파악합니다.
- REASON_CHECK: describeTable → executeQuery 순서로 데이터 상태를 확인합니다.
- 필요한 경우 listFiles, listTables로 구조부터 파악합니다.
`;

/**
 * 시스템 프롬프트를 생성합니다.
 * USE_MOCK_CONTEXT=true일 때 mockContextText가 추가됩니다.
 */
export function buildSystemPrompt(mockContextText?: string): string {
  if (!mockContextText) return BASE_SYSTEM_PROMPT;

  return `${BASE_SYSTEM_PROMPT}
[사전 컨텍스트 — 참고용 Mock 데이터]
${mockContextText}
`;
}

/**
 * 사용자 메시지를 생성합니다.
 * Claude에게 전달되는 첫 번째 user 메시지입니다.
 */
export function buildUserMessage(classified: ClassifiedQuery): string {
  const { request, queryType } = classified;
  const lines = [
    `[문의 유형] ${queryType}`,
    `[회원사] ${request.memberId}`,
    `[요청자] ${request.requester.userId} (role: ${request.requester.role})`,
  ];

  if (request.context?.screenId) lines.push(`[화면 ID] ${request.context.screenId}`);
  if (request.context?.menuName) lines.push(`[메뉴] ${request.context.menuName}`);
  if (request.context?.keyValues) {
    const kv = Object.entries(request.context.keyValues)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`[조회 키] ${kv}`);
  }

  lines.push("", `[질의]`, request.question);
  return lines.join("\n");
}

// ── Mock 컨텍스트 (USE_MOCK_CONTEXT=true 전용) ────────────

export function buildMockContextText(memberId: string): string {
  return [
    `회원사 ID: ${memberId}`,
    `계약 상태: active (Mock 데이터)`,
    `참고: 이 컨텍스트는 Mock 데이터입니다. 실제 DB 데이터가 우선합니다.`,
  ].join("\n");
}
