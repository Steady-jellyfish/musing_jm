import "dotenv/config";
import { classifyQuery } from "./preprocess/classifier.js";
import { Orchestrator } from "./orchestrator/index.js";
import type { RawInquiry } from "./preprocess/types.js";

/**
 * 진입점 — 실제 운영 시 입출력 담당(한상민)으로부터 RawInquiry를 수신
 * 현재는 로컬 테스트용 예시 실행
 */
async function main() {
  const orchestrator = new Orchestrator();

  // 테스트용 원시 문의
  const testInquiry: RawInquiry = {
    memberId: "MBR-001",
    rawText: "12월 수수료가 너무 많이 나온 것 같아요. 확인 부탁드립니다.",
  };

  console.log("[main] 원시 문의 수신:", testInquiry);

  // 1. 유형 판별
  const classified = await classifyQuery(testInquiry);
  console.log("[main] 유형 판별 결과:", classified);

  // 2. 오케스트레이션 (컨텍스트 수집 → 프롬프트 조립 → Claude 호출)
  const result = await orchestrator.process(classified);
  console.log("[main] 최종 결과:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[main] 오류:", err);
  process.exit(1);
});
