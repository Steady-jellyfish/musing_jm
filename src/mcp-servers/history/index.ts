import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Mock 데이터 ──────────────────────────────────────────
const mockHistory: Record<
  string,
  Array<{
    caseId: string;
    queryType: string;
    rawText: string;
    resolvedAt: string;
    resolution: string;
    handledBy: string;
  }>
> = {
  "MBR-001": [
    {
      caseId: "CASE-2024-1201",
      queryType: "fee_inquiry",
      rawText: "12월 수수료가 왜 이렇게 많이 나왔나요?",
      resolvedAt: "2024-12-05T14:30:00Z",
      resolution: "11월 이월 정산분이 포함된 것으로 확인. 정상 청구임을 안내.",
      handledBy: "auto",
    },
    {
      caseId: "CASE-2024-1089",
      queryType: "cms_error",
      rawText: "CMS E002 오류가 반복됩니다",
      resolvedAt: "2024-11-20T09:15:00Z",
      resolution: "월 한도 초과 확인. 한도 증액 신청 안내 후 처리.",
      handledBy: "auto",
    },
  ],
  "MBR-002": [
    {
      caseId: "CASE-2024-0892",
      queryType: "contract_inquiry",
      rawText: "계약 만료일이 언제인가요?",
      resolvedAt: "2024-10-01T11:00:00Z",
      resolution: "계약 만료일 2025-05-31 안내.",
      handledBy: "auto",
    },
  ],
};

// ── MCP 서버 정의 ────────────────────────────────────────
const server = new McpServer({
  name: "history-mcp",
  version: "0.1.0",
});

/**
 * 회원사 처리 이력 조회
 */
server.tool(
  "getProcessingHistory",
  "특정 회원사의 과거 문의 처리 이력을 조회합니다.",
  {
    memberId: z.string().describe("회원사 식별자"),
    queryType: z
      .enum(["fee_inquiry", "cms_error", "contract_inquiry", "pkg_su_calc", "issue_pattern"])
      .optional()
      .describe("특정 유형으로 필터링 (생략 시 전체)"),
    limit: z.number().int().min(1).max(20).default(5).describe("최대 반환 개수"),
  },
  async ({ memberId, queryType, limit }) => {
    const cases = mockHistory[memberId] ?? [];

    const filtered = queryType
      ? cases.filter((c) => c.queryType === queryType)
      : cases;

    const results = filtered.slice(0, limit);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              memberId,
              queryType: queryType ?? "all",
              count: results.length,
              cases: results,
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
