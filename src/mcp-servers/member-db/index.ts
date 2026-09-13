import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Mock 데이터 ──────────────────────────────────────────
const mockMemberDb: Record<
  string,
  {
    memberId: string;
    companyName: string;
    contract: Record<string, unknown>;
    org: Record<string, unknown>;
    hr: Record<string, unknown>;
  }
> = {
  "MBR-001": {
    memberId: "MBR-001",
    companyName: "(주)샘플기업",
    contract: {
      contractId: "CTR-2024-001",
      status: "active",
      plan: "enterprise",
      startDate: "2024-01-01",
      endDate: "2025-12-31",
      monthlyFeeLimit: 5000000,
      discountRate: 0.1,
    },
    org: {
      department: "재무팀",
      contactName: "홍길동",
      contactEmail: "hong@sample.com",
    },
    hr: {
      employeeCount: 250,
      tier: "large",
    },
  },
  "MBR-002": {
    memberId: "MBR-002",
    companyName: "(주)테스트컴퍼니",
    contract: {
      contractId: "CTR-2024-042",
      status: "active",
      plan: "standard",
      startDate: "2024-06-01",
      endDate: "2025-05-31",
      monthlyFeeLimit: 1000000,
      discountRate: 0,
    },
    org: {
      department: "경영지원팀",
      contactName: "김철수",
      contactEmail: "kim@test.com",
    },
    hr: {
      employeeCount: 50,
      tier: "medium",
    },
  },
};

// ── MCP 서버 정의 (read-only) ────────────────────────────
const server = new McpServer({
  name: "member-db-mcp",
  version: "0.1.0",
});

/**
 * 회원사 기본 정보 조회 (read-only)
 */
server.tool(
  "getMemberInfo",
  "회원사 ID로 계약/조직/인사 정보를 조회합니다. 조회 전용(read-only)입니다.",
  {
    memberId: z.string().describe("회원사 식별자 (예: MBR-001)"),
    fields: z
      .array(z.enum(["contract", "org", "hr"]))
      .default(["contract", "org"])
      .describe("조회할 정보 필드"),
  },
  async ({ memberId, fields }) => {
    const member = mockMemberDb[memberId];

    if (!member) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `회원사 ID '${memberId}'를 찾을 수 없습니다.` }),
          },
        ],
        isError: true,
      };
    }

    const result: Record<string, unknown> = {
      memberId: member.memberId,
      companyName: member.companyName,
    };

    for (const field of fields) {
      result[field] = member[field];
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ── 서버 시작 ────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
