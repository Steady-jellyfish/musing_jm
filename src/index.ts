/**
 * 애플리케이션 진입점
 *
 * 1. Git 저장소 동기화 시작 (백그라운드)
 * 2. Fastify 앱 시작
 * 3. SIGINT/SIGTERM 핸들러로 graceful shutdown
 *
 * Agent SDK 전환 이후에는 MCP 서버 연결을 AgentRunner가 요청 단위로 처리하므로
 * 별도의 초기화(orchestrator.initialize) 가 필요 없습니다.
 */

import { buildApp } from "./server/app.js";
import { repoSyncManager } from "./git-sync/repo-manager.js";
import { env } from "./config/env.js";

async function main() {
  // Git 저장소 동기화 시작 (비동기, 서버 기동 차단 안 함)
  await repoSyncManager.initialize();

  const app = await buildApp();

  try {
    await app.listen({ port: env.port, host: "0.0.0.0" });
    process.stderr.write(`INFO [server] http://0.0.0.0:${env.port} 에서 수신 중\n`);
    process.stderr.write(`INFO [server] Swagger UI: http://localhost:${env.port}/docs\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  async function shutdown(signal: string) {
    process.stderr.write(`\nINFO [server] ${signal} 수신 — 서버를 종료합니다.\n`);
    await app.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("서버 시작 실패:", err);
  process.exit(1);
});
