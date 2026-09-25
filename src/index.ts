/**
 * 애플리케이션 진입점 (Phase 5)
 *
 * 1. Orchestrator 초기화 (MCP 서버 연결)
 * 2. Fastify 앱 시작
 * 3. SIGINT/SIGTERM 핸들러로 graceful shutdown
 */

import { buildApp } from "./server/app.js";
import { orchestrator } from "./server/routes/inquiry.js";
import { mcpManager } from "./orchestrator/mcp-client.js";
import { repoSyncManager } from "./git-sync/repo-manager.js";
import { env } from "./config/env.js";

async function main() {
  // Git 저장소 동기화 시작 (비동기, 서버 기동 차단 안 함)
  // 첫 clone 포함 모든 작업이 백그라운드에서 진행됩니다.
  await repoSyncManager.initialize();

  // MCP 서버 초기화 (erp-git, erp-db 연결)
  await orchestrator.initialize();

  // Fastify 앱 생성 및 시작
  const app = await buildApp();

  try {
    await app.listen({ port: env.port, host: "0.0.0.0" });
    process.stderr.write(`INFO [server] http://0.0.0.0:${env.port} 에서 수신 중\n`);
    process.stderr.write(`INFO [server] Swagger UI: http://localhost:${env.port}/docs\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  async function shutdown(signal: string) {
    process.stderr.write(`\nINFO [server] ${signal} 수신 — 서버를 종료합니다.\n`);
    await app.close();
    await mcpManager.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("서버 시작 실패:", err);
  process.exit(1);
});
