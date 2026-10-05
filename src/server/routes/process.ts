/**
 * /process, /cancel, /health 라우트
 *
 * Front-end API 스펙에 맞춘 라우트 핸들러입니다.
 */

import type { FastifyInstance } from "fastify";
import {
  ProcessRequestSchema,
  ProcessResponseSchema,
  CancelRequestSchema,
  CancelResponseSchema,
  HealthResponseSchema,
  type ProcessRequestBody,
  type ProcessResponse,
  type CancelRequestBody,
} from "../schemas/process.js";
import { AgentRunner } from "../../agent/agent-runner.js";
import { sessionStore } from "../../agent/session-store.js";

export const agentRunner = new AgentRunner(sessionStore);

export async function processRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /health ──────────────────────────────────────────
  app.get(
    "/health",
    {
      schema: {
        summary: "상태 확인 (운영 모니터링)",
        tags: ["system"],
        response: { 200: HealthResponseSchema },
      },
    },
    async () => ({
      ok: true,
      running: sessionStore.runningCount,
      queued: sessionStore.queuedCount,
    })
  );

  // ── POST /process ────────────────────────────────────────
  app.post<{ Body: ProcessRequestBody; Reply: ProcessResponse }>(
    "/process",
    {
      schema: {
        summary: "질의 처리",
        description:
          "자연어 질문을 받아 ERP 코드베이스와 DB를 분석해 답변합니다. " +
          "되묻기(waiting_input) 상태에서 answers를 포함해 재요청하면 분석을 이어갑니다.",
        tags: ["process"],
        body: ProcessRequestSchema,
        response: { 200: ProcessResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;

      try {
        const result = await agentRunner.run({
          question: body.question,
          memberId: body.memberId,
          sessionId: body.sessionId,
          answers: body.answers,
          requestId: body.requestId,
        });

        return reply.status(200).send({
          status: result.status,
          sessionId: result.sessionId,
          type: result.type,
          answer: result.answer,
          references: result.references,
          questions: result.questions,
          trace: result.trace,
          usage: result.usage,
          error: result.error,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        app.log.error({ requestId: body.requestId }, `[process] 처리 실패: ${errorMsg}`);
        return reply.status(200).send({
          status: "failed",
          sessionId: body.sessionId ?? "",
          trace: [],
          error: errorMsg,
        });
      }
    }
  );

  // ── POST /cancel ─────────────────────────────────────────
  app.post<{ Body: CancelRequestBody }>(
    "/cancel",
    {
      schema: {
        summary: "요청 취소",
        description: "requestId로 실행 중인 /process 요청을 취소합니다.",
        tags: ["process"],
        body: CancelRequestSchema,
        response: { 200: CancelResponseSchema },
      },
    },
    async (request, reply) => {
      const { requestId } = request.body;
      const canceled = sessionStore.cancelRequest(requestId);
      return reply.status(200).send({ canceled });
    }
  );
}
