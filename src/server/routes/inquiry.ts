import type { FastifyInstance } from "fastify";
import type { InquiryRequestBody, InquiryResponse } from "../schemas/inquiry.js";
import { InquiryRequestSchema, InquiryResponseSchema, HealthResponseSchema } from "../schemas/inquiry.js";
import { classifyQuery } from "../../preprocess/classifier.js";
import { checkPermission } from "../../auth/permission.js";
import { Orchestrator } from "../../orchestrator/index.js";
import { OrchestratorError } from "../../orchestrator/types.js";
import { mcpManager } from "../../orchestrator/mcp-client.js";

export const orchestrator = new Orchestrator();

const EMPTY_META = { model: "unknown", toolCallCount: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 };

/**
 * /health 와 /api/v1/inquiry 라우트를 등록합니다.
 */
export async function inquiryRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /health ─────────────────────────────────────
  app.get(
    "/health",
    {
      schema: {
        summary: "헬스체크",
        tags: ["system"],
        response: { 200: HealthResponseSchema },
      },
    },
    async () => ({
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      mcp: mcpManager.getStatuses(),
    })
  );

  // ── POST /api/v1/inquiry ─────────────────────────────
  app.post<{ Body: InquiryRequestBody; Reply: InquiryResponse }>(
    "/api/v1/inquiry",
    {
      schema: {
        summary: "문의 처리",
        description: "Gateway로부터 정제된 문의를 받아 Claude가 ERP 소스/DB를 참조해 답변을 생성합니다.",
        tags: ["inquiry"],
        body: InquiryRequestSchema,
        response: { 200: InquiryResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;

      // Step 1. queryType 검증 (LOGIC_CHECK / REASON_CHECK 외 값 보정 포함)
      const classified = classifyQuery(body);

      // Step 2. 권한 확인 (memberId + role)
      const permission = checkPermission(body.memberId, body.requester.role);
      if (!permission.allowed) {
        app.log.warn(
          { requestId: body.requestId, memberId: body.memberId, role: body.requester.role },
          `[inquiry] 권한 거부: ${permission.reason}`
        );
        return reply.status(200).send({
          requestId: body.requestId,
          status: "REJECTED",
          answer: "",
          references: [],
          meta: EMPTY_META,
          error: { code: "PERMISSION_DENIED", message: permission.reason },
        });
      }

      // Step 3. 오케스트레이션 (Claude API + MCP tool_use 루프)
      try {
        const result = await orchestrator.process(classified);
        return reply.status(200).send({
          requestId: body.requestId,
          status: "SUCCESS",
          answer: result.answer,
          references: result.references,
          meta: result.meta,
        });
      } catch (err) {
        // OrchestratorError는 code를 그대로 전달
        const code = err instanceof OrchestratorError ? err.code : "INTERNAL_ERROR";
        const message = err instanceof Error ? err.message : "알 수 없는 오류";
        app.log.error({ requestId: body.requestId, code }, "[inquiry] 처리 실패");
        return reply.status(200).send({
          requestId: body.requestId,
          status: "FAILED",
          answer: "",
          references: [],
          meta: EMPTY_META,
          error: { code, message },
        });
      }
    }
  );
}
