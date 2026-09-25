import { Type, type Static } from "@sinclair/typebox";

/**
 * TypeBox로 요청/응답 스키마를 정의합니다.
 *
 * TypeBox를 쓰는 이유:
 * - JSON Schema와 TypeScript 타입을 동시에 표현 → 코드 중복 없이 Fastify 검증 + 타입 추론 가능
 * - @fastify/swagger가 TypeBox 스키마를 그대로 OpenAPI 문서로 변환
 */

// ── 요청 스키마 ──────────────────────────────────────────

const RequesterSchema = Type.Object({
  userId: Type.String({ description: "요청자 사용자 ID" }),
  role: Type.String({ description: "요청자 역할 (권한 확인에 사용)" }),
});

const ContextSchema = Type.Optional(
  Type.Object({
    screenId: Type.Optional(Type.String({ description: "화면 ID" })),
    menuName: Type.Optional(Type.String({ description: "메뉴 이름" })),
    keyValues: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "조회 키-값 쌍 (예: {사번: '12345'})",
      })
    ),
  })
);

export const InquiryRequestSchema = Type.Object(
  {
    requestId: Type.String({ description: "Gateway 발급 요청 ID (UUID)" }),
    memberId: Type.String({ description: "회원사 식별자 (예: HANWHA_LIFELAB)" }),
    targetSystem: Type.String({
      description:
        "대상 시스템 (예: ERP, CMS). memberId + targetSystem 조합으로 참조 Git 저장소를 결정합니다. " +
        "설정에 없는 조합이면 REJECTED(UNSUPPORTED_TARGET)를 반환합니다.",
      minLength: 1,
    }),
    queryType: Type.Union(
      [Type.Literal("LOGIC_CHECK"), Type.Literal("REASON_CHECK")],
      { description: "문의 유형 (Gateway가 1차 판별)" }
    ),
    question: Type.String({ description: "정제된 질의 텍스트", minLength: 1 }),
    requester: RequesterSchema,
    context: ContextSchema,
  },
  { $id: "InquiryRequest" }
);

export type InquiryRequestBody = Static<typeof InquiryRequestSchema>;

// ── 응답 스키마 ──────────────────────────────────────────

const CodeReferenceSchema = Type.Object({
  type: Type.Literal("CODE"),
  repo: Type.String({ description: "Git 저장소 ID (config/repos.json의 id)" }),
  path: Type.String({ description: "파일 경로" }),
  lineStart: Type.Integer({ description: "시작 라인" }),
  lineEnd: Type.Integer({ description: "종료 라인" }),
});

const DbReferenceSchema = Type.Object({
  type: Type.Literal("DB"),
  table: Type.String({ description: "참조 테이블명" }),
  query: Type.String({ description: "실행한 SELECT 쿼리" }),
});

const ReferenceSchema = Type.Union([CodeReferenceSchema, DbReferenceSchema], {
  description: "Claude가 참조한 소스 또는 DB 쿼리",
});

const MetaSchema = Type.Object({
  model: Type.String({ description: "사용된 Claude 모델" }),
  toolCallCount: Type.Integer({ description: "도구 호출 횟수" }),
  inputTokens: Type.Integer({ description: "입력 토큰 수" }),
  outputTokens: Type.Integer({ description: "출력 토큰 수" }),
  elapsedMs: Type.Integer({ description: "처리 시간 (ms)" }),
  codeBaseAt: Type.Optional(
    Type.String({
      description:
        "저장소 캐시의 마지막 동기화 시각 (ISO 8601). " +
        "동기화 상태가 stale이거나 syncing 중 기존 캐시를 사용한 경우에 포함됩니다.",
    })
  ),
});

const ErrorSchema = Type.Optional(
  Type.Object({
    code: Type.String({ description: "오류 코드" }),
    message: Type.String({ description: "오류 메시지" }),
  })
);

export const InquiryResponseSchema = Type.Object(
  {
    requestId: Type.String({ description: "요청 ID (echo)" }),
    status: Type.Union(
      [
        Type.Literal("SUCCESS"),
        Type.Literal("FAILED"),
        Type.Literal("REJECTED"),
      ],
      { description: "처리 결과 상태" }
    ),
    answer: Type.String({ description: "Claude가 생성한 답변" }),
    references: Type.Array(ReferenceSchema, {
      description: "답변 근거 (참조한 소스 파일 / DB 쿼리)",
    }),
    meta: MetaSchema,
    error: ErrorSchema,
  },
  { $id: "InquiryResponse" }
);

export type InquiryResponse = Static<typeof InquiryResponseSchema>;

// ── 헬스체크 스키마 ──────────────────────────────────────

const McpServerStatusSchema = Type.Object({
  name: Type.String({ description: "MCP 서버 이름" }),
  status: Type.Union(
    [Type.Literal("connected"), Type.Literal("skipped"), Type.Literal("error")],
    { description: "연결 상태" }
  ),
  reason: Type.Optional(Type.String({ description: "건너뜀/오류 사유" })),
  tools: Type.Optional(
    Type.Array(Type.String(), { description: "연결된 경우 제공 도구 목록" })
  ),
});

const RepoStatusSchema = Type.Object({
  id: Type.String({ description: "저장소 ID (config/repos.json의 id)" }),
  description: Type.Optional(Type.String()),
  status: Type.Union(
    [
      Type.Literal("syncing"),
      Type.Literal("synced"),
      Type.Literal("stale"),
      Type.Literal("missing"),
    ],
    {
      description:
        "동기화 상태: syncing(진행 중) / synced(완료) / " +
        "stale(실패·기존 캐시 사용 중) / missing(설정 없음 또는 캐시 없음)",
    }
  ),
  syncedAt: Type.Optional(
    Type.String({ description: "마지막 성공 동기화 시각 (stale 상태에서도 보존)" })
  ),
  warning: Type.Optional(Type.String({ description: "경고 메시지 (stale/missing 시)" })),
});

export const HealthResponseSchema = Type.Object({
  status: Type.Literal("ok"),
  timestamp: Type.String(),
  mcp: Type.Array(McpServerStatusSchema, { description: "MCP 서버별 연결 상태" }),
  repos: Type.Array(RepoStatusSchema, { description: "Git 저장소별 동기화 상태" }),
});

export type HealthResponse = Static<typeof HealthResponseSchema>;
