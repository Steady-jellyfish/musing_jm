import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { inquiryRoutes } from "./routes/inquiry.js";

/**
 * Fastify 앱 인스턴스를 생성하고 플러그인·라우트를 등록합니다.
 *
 * 팩토리 함수로 분리하는 이유: index.ts는 "시작"만 담당, 나중에 테스트 시 app만 따로 생성 가능.
 */
export async function buildApp() {
  const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

  // ── Swagger (OpenAPI 문서 자동 생성) ────────────────
  // @fastify/swagger가 스키마를 읽어 OpenAPI JSON을 만들고,
  // @fastify/swagger-ui가 /docs 경로에 브라우저 UI를 제공합니다.
  await app.register(swagger, {
    openapi: {
      info: {
        title: "musing_jm API",
        description: "한화라이프랩 ERP 문의 처리 백엔드 (로직 확인 / 사유 확인)",
        version: "0.1.0",
      },
      tags: [
        { name: "inquiry", description: "문의 처리 엔드포인트" },
        { name: "system", description: "시스템 상태" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list" },
  });

  // ── 라우트 등록 ─────────────────────────────────────
  await app.register(inquiryRoutes);

  return app;
}
