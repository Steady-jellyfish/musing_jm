import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { processRoutes } from "./routes/process.js";

/**
 * Fastify 앱 인스턴스를 생성하고 플러그인·라우트를 등록합니다.
 */
export async function buildApp() {
  const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(swagger, {
    openapi: {
      info: {
        title: "musing_jm API",
        description: "ERP 자연어 질의 처리 서버 (Agent SDK 기반)",
        version: "0.2.0",
      },
      tags: [
        { name: "process", description: "질의 처리" },
        { name: "system", description: "시스템 상태" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list" },
  });

  await app.register(processRoutes);

  return app;
}
