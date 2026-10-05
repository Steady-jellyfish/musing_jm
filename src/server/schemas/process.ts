/**
 * /process, /cancel, /health 스키마 (TypeBox)
 *
 * Front-end API 스펙에 맞춰 정의된 요청/응답 스키마입니다.
 */

import { Type, Static } from "@sinclair/typebox";

// ── /process 요청 ─────────────────────────────────────────

export const ProcessRequestSchema = Type.Object(
  {
    question: Type.String({ description: "자연어 질문" }),
    memberId: Type.String({ description: "회원사 ID" }),
    sessionId: Type.Optional(Type.String({ description: "채팅 세션 ID" })),
    answers: Type.Optional(
      Type.Record(
        Type.String(),
        Type.String(),
        { description: "되묻기 응답: { 질문: 선택한 라벨 }" }
      )
    ),
    requestId: Type.String({ description: "콘솔 발급. 취소·재시도 중복 차단용" }),
  },
  { $id: "ProcessRequest" }
);

export type ProcessRequestBody = Static<typeof ProcessRequestSchema>;

// ── 공통 서브타입 ─────────────────────────────────────────

const ReferenceSchema = Type.Object({
  locator: Type.String({ description: "코드: path:line, DB: 테이블명" }),
  description: Type.String(),
});

const TraceEntrySchema = Type.Object({
  label: Type.String(),
  detail: Type.Optional(Type.String()),
  elapsedMs: Type.Number(),
});

const ClarificationOptionSchema = Type.Object({
  label: Type.String(),
  description: Type.String(),
});

const ClarificationQuestionSchema = Type.Object({
  question: Type.String(),
  options: Type.Array(ClarificationOptionSchema),
  multiSelect: Type.Boolean(),
});

const UsageSchema = Type.Object({
  elapsedMs: Type.Number(),
  tokens: Type.Optional(Type.Number()),
  filesRead: Type.Optional(Type.Number()),
  dbQueries: Type.Optional(Type.Number()),
});

// ── /process 응답 ─────────────────────────────────────────

export const ProcessResponseSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("done"),
      Type.Literal("waiting_input"),
      Type.Literal("failed"),
    ]),
    sessionId: Type.String(),
    type: Type.Optional(
      Type.Union([Type.Literal("LOGIC_REVIEW"), Type.Literal("ERROR_CAUSE")])
    ),

    // status === "done"
    answer: Type.Optional(Type.String()),
    references: Type.Optional(Type.Array(ReferenceSchema)),
    usage: Type.Optional(UsageSchema),

    // status === "waiting_input"
    questions: Type.Optional(Type.Array(ClarificationQuestionSchema)),

    // 공통
    trace: Type.Array(TraceEntrySchema),

    // status === "failed"
    error: Type.Optional(Type.String()),
  },
  { $id: "ProcessResponse" }
);

export type ProcessResponse = Static<typeof ProcessResponseSchema>;

// ── /cancel 요청 ──────────────────────────────────────────

export const CancelRequestSchema = Type.Object(
  {
    requestId: Type.String(),
    sessionId: Type.Optional(Type.String()),
  },
  { $id: "CancelRequest" }
);

export type CancelRequestBody = Static<typeof CancelRequestSchema>;

// ── /cancel 응답 ──────────────────────────────────────────

export const CancelResponseSchema = Type.Object(
  { canceled: Type.Boolean() },
  { $id: "CancelResponse" }
);

export type CancelResponse = Static<typeof CancelResponseSchema>;

// ── /health 응답 ──────────────────────────────────────────

export const HealthResponseSchema = Type.Object(
  {
    ok: Type.Boolean(),
    running: Type.Number({ description: "처리 중인 건수" }),
    queued: Type.Number({ description: "대기 중인 건수" }),
  },
  { $id: "HealthResponse" }
);

export type HealthResponse = Static<typeof HealthResponseSchema>;
