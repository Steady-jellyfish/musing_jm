/**
 * 로컬 테스트용 실행 스크립트 (HTTP 서버 없이 직접 흐름 확인)
 * 실행: npm run dev:test
 */
import "dotenv/config";
import { classifyQuery } from "./preprocess/classifier.js";
import { Orchestrator } from "./orchestrator/index.js";
import type { InquiryRequest } from "./preprocess/types.js";

async function main() {
  const orchestrator = new Orchestrator();

  const testRequest: InquiryRequest = {
    requestId: "test-001",
    memberId: "HANWHA_LIFELAB",
    queryType: "LOGIC_CHECK",
    question: "PKG_SU_CALC 로직이 어디에 구현되어 있나요?",
    requester: { userId: "dev-user", role: "developer" },
  };

  console.log("[dev-runner] 테스트 요청:", testRequest);

  const classified = classifyQuery(testRequest);
  console.log("[dev-runner] 검증 결과:", classified);

  const result = await orchestrator.process(classified);
  console.log("[dev-runner] 최종 결과:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[dev-runner] 오류:", err);
  process.exit(1);
});
