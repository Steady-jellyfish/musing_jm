import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { KbCategory } from "../../config/types.js";

// ── Mock 데이터 ──────────────────────────────────────────
const mockKnowledgeBase: Record<KbCategory, Array<{ id: string; title: string; content: string }>> = {
  fee: [
    {
      id: "fee-001",
      title: "기본 수수료 정책 v3.2",
      content: "거래 금액의 1.5%를 수수료로 부과. 월 최대 한도 500만원. 특약 적용 시 별도 협의.",
    },
    {
      id: "fee-002",
      title: "수수료 감면 기준",
      content: "연간 거래액 10억 이상 회원사는 0.1% 감면 적용. 신청 후 익월 적용.",
    },
  ],
  cms: [
    {
      id: "cms-001",
      title: "CMS 오류 코드 목록",
      content: "E001: 인증 실패 / E002: 한도 초과 / E003: 계좌 불일치 / E999: 시스템 오류",
    },
  ],
  pkg_su_calc: [
    {
      id: "pkg-001",
      title: "PKG_SU_CALC 계산 로직",
      content: "기본단가 × 수량 × (1 - 패키지할인율). 할인율은 계약서 PKG_DISC_RATE 필드 참조.",
    },
  ],
  issue_pattern: [
    {
      id: "issue-001",
      title: "반복 이슈 패턴: 월말 정산 오류",
      content: "매월 말일 23:00~24:00 사이 정산 배치 충돌로 이중 청구 발생. 임시 조치: 해당 시간대 수동 처리.",
    },
  ],
};

// ── MCP 서버 정의 ────────────────────────────────────────
const server = new McpServer({
  name: "knowledge-base-mcp",
  version: "0.1.0",
});

/**
 * 지식베이스 검색 툴
 * 카테고리 + 키워드로 관련 항목을 반환합니다.
 */
server.tool(
  "searchKnowledgeBase",
  "지식베이스(수수료/CMS/PKG_SU_CALC/이슈패턴)에서 관련 항목을 조회합니다.",
  {
    category: z
      .enum(["fee", "cms", "pkg_su_calc", "issue_pattern"])
      .describe("조회할 지식베이스 카테고리"),
    keyword: z.string().describe("검색 키워드"),
    limit: z.number().int().min(1).max(10).default(3).describe("최대 반환 개수"),
  },
  async ({ category, keyword, limit }) => {
    const items = mockKnowledgeBase[category as KbCategory] ?? [];
    const kw = keyword.toLowerCase();

    const matched = items
      .filter(
        (item) =>
          item.title.toLowerCase().includes(kw) ||
          item.content.toLowerCase().includes(kw)
      )
      .slice(0, limit);

    // 키워드 매칭 없으면 전체 반환 (상위 limit개)
    const results = matched.length > 0 ? matched : items.slice(0, limit);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              category,
              keyword,
              count: results.length,
              items: results,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── 서버 시작 ────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
