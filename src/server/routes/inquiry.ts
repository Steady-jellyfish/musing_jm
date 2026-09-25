import type { FastifyInstance } from "fastify";
import type { InquiryRequestBody, InquiryResponse } from "../schemas/inquiry.js";
import { InquiryRequestSchema, InquiryResponseSchema, HealthResponseSchema } from "../schemas/inquiry.js";
import { classifyQuery } from "../../preprocess/classifier.js";
import { checkPermission } from "../../auth/permission.js";
import { Orchestrator } from "../../orchestrator/index.js";
import { OrchestratorError } from "../../orchestrator/types.js";
import { mcpManager } from "../../orchestrator/mcp-client.js";
import { repoSyncManager } from "../../git-sync/repo-manager.js";

export const orchestrator = new Orchestrator();

const EMPTY_META = {
  model: "unknown",
  toolCallCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  elapsedMs: 0,
} as const;

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
      repos: repoSyncManager.getStatuses(),
    })
  );

  // ── POST /api/v1/inquiry ─────────────────────────────
  app.post<{ Body: InquiryRequestBody; Reply: InquiryResponse }>(
    "/api/v1/inquiry",
    {
      schema: {
        summary: "문의 처리",
        description:
          "Gateway로부터 정제된 문의를 받아 Claude가 ERP 소스/DB를 참조해 답변을 생성합니다. " +
          "memberId + targetSystem으로 접근할 Git 저장소를 결정합니다.",
        tags: ["inquiry"],
        body: InquiryRequestSchema,
        response: { 200: InquiryResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;

      // ── Step 0. targetSystem → 저장소 조회 ──────────────
      const repoInfo = repoSyncManager.getRepoForRequest(body.memberId, body.targetSystem);

      if (!repoInfo) {
        return reply.status(200).send({
          requestId: body.requestId,
          status: "REJECTED",
          answer: "",
          references: [],
          meta: EMPTY_META,
          error: {
            code: "UNSUPPORTED_TARGET",
            message: `'${body.memberId}'에 대한 '${body.targetSystem}' 저장소 설정이 없습니다.`,
          },
        });
      }

      // ── Step 1. 저장소 상태별 처리 분기 ─────────────────
      const { status: repoStatus, hasCache } = repoInfo;
      let codeBaseAt: string | undefined;

      if (repoStatus.status === "missing") {
        app.log.warn(
          { repoId: repoInfo.config.id, memberId: body.memberId },
          "[inquiry] 저장소 접근 불가 (missing)"
        );
        return reply.status(200).send({
          requestId: body.requestId,
          status: "FAILED",
          answer: "",
          references: [],
          meta: EMPTY_META,
          error: {
            code: "GIT_UNAVAILABLE",
            message:
              "저장소 접근 문제로 확인이 어렵습니다. 담당 개발자에게 전달되었습니다.",
          },
        });
      }

      if (repoStatus.status === "syncing" && !hasCache) {
        // 첫 clone 진행 중이고 캐시 없음
        return reply.status(200).send({
          requestId: body.requestId,
          status: "FAILED",
          answer: "",
          references: [],
          meta: EMPTY_META,
          error: {
            code: "REPO_SYNCING",
            message: "저장소 준비 중입니다. 잠시 후 다시 시도해주세요.",
          },
        });
      }

      if (repoStatus.status === "syncing" && hasCache) {
        // 재기동 등으로 최신화 중이지만 기존 캐시 존재 → 정상 처리
        codeBaseAt = repoStatus.syncedAt;
      } else if (repoStatus.status === "stale") {
        // 동기화 실패, 기존 캐시 사용 중
        codeBaseAt = repoStatus.syncedAt;
      }
      // synced: codeBaseAt = undefined

      // ── Step 2. queryType 검증 ───────────────────────────
      const classified = classifyQuery(body);

      // ── Step 3. 권한 확인 ────────────────────────────────
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

      // ── Step 4. Orchestrator 호출 ─────────────────────────
      try {
        const result = await orchestrator.process(classified, {
          allowedRepos: [repoInfo.config.id],
          codeBaseAt,
        });

        return reply.status(200).send({
          requestId: body.requestId,
          status: "SUCCESS",
          answer: result.answer,
          references: result.references,
          meta: result.meta,
        });
      } catch (err) {
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
