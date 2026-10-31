/**
 * /process, /cancel, /health 라우트
 *
 * /process: SSE 스트림으로 응답합니다.
 *   이벤트 순서: connected → trace (반복) → clarification | done | error
 *
 * 채팅형 연속 대화:
 *   sessionId를 재사용해 follow-up 질문을 보내면 이전 대화 맥락이 유지됩니다.
 */

import type { FastifyInstance } from "fastify";
import {
  ProcessRequestSchema,
  CancelRequestSchema,
  CancelResponseSchema,
  HealthResponseSchema,
  type ProcessRequestBody,
  type CancelRequestBody,
} from "../schemas/process.js";
import { AgentRunner } from "../../agent/agent-runner.js";
import { sessionStore } from "../../agent/session-store.js";

export const agentRunner = new AgentRunner(sessionStore);

/** SSE 헬퍼: "event: <name>\ndata: <json>\n\n" 형식으로 씁니다 */
function writeEvent(raw: NodeJS.WritableStream, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

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

  // ── POST /process (SSE 스트림) ────────────────────────────
  app.post<{ Body: ProcessRequestBody }>(
    "/process",
    {
      schema: {
        summary: "질의 처리 (SSE 스트림)",
        description:
          "자연어 질문을 처리하고 결과를 SSE 이벤트 스트림으로 반환합니다.\n\n" +
          "**이벤트 타입**\n" +
          "- `connected`: 세션 시작. `{ sessionId }` 포함\n" +
          "- `trace`: 처리 단계 실시간 알림. `{ label, detail?, elapsedMs }` 포함\n" +
          "- `clarification`: 추가 정보 필요. `{ questions, type? }` 포함. answers와 함께 재요청하세요\n" +
          "- `done`: 분석 완료. `{ answer, references, type?, usage }` 포함\n" +
          "- `error`: 처리 실패. `{ sessionId, error }` 포함\n\n" +
          "**채팅 연속 대화**: done 이후에도 같은 sessionId로 다음 질문을 보내면 맥락이 유지됩니다.",
        tags: ["process"],
        body: ProcessRequestSchema,
      },
    },
    async (request, reply) => {
      const body = request.body;

      // SSE 헤더 설정
      reply.raw.statusCode = 200;
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no"); // Nginx 버퍼링 비활성화

      // Fastify의 자동 응답 처리를 비활성화하고 raw 스트림을 직접 제어합니다
      reply.hijack();

      try {
        for await (const evt of agentRunner.runStream(body)) {
          writeEvent(reply.raw, evt.event, evt.data);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        app.log.error({ requestId: body.requestId }, `[process] 스트림 오류: ${errorMsg}`);
        writeEvent(reply.raw, "error", { sessionId: body.sessionId ?? "", error: errorMsg });
      } finally {
        reply.raw.end();
      }
    }
  );

  // ── POST /cancel ─────────────────────────────────────────
  app.post<{ Body: CancelRequestBody }>(
    "/cancel",
    {
      schema: {
        summary: "요청 취소",
        description: "requestId로 실행 중인 /process 요청을 취소합니다. SSE 스트림이 종료됩니다.",
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
