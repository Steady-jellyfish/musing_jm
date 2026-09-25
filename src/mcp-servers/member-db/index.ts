/**
 * member-db MCP 서버 (Mock)
 *
 * 회원사 정보 및 권한 확인을 제공합니다.
 * Phase 2: checkPermission 도구 추가 (auth/permission.ts와 동일 로직)
 *
 * 실행: npx tsx src/mcp-servers/member-db/index.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Mock 데이터 ───────────────────────────────────────────

interface MemberInfo {
  memberId: string;
  name: string;
  status: "active" | "inactive";
  contractStart: string;
  allowedRoles: string[];
}

const MEMBERS: MemberInfo[] = [
  {
    memberId: "HANWHA_LIFELAB",
    name: "한화라이프랩",
    status: "active",
    contractStart: "2024-01-01",
    allowedRoles: ["admin", "developer", "operator", "manager", "analyst"],
  },
  {
    memberId: "MBR-001",
    name: "테스트 회원사 A",
    status: "active",
    contractStart: "2024-03-15",
    allowedRoles: ["admin", "developer", "operator", "manager"],
  },
  {
    memberId: "MBR-002",
    name: "테스트 회원사 B",
    status: "inactive",
    contractStart: "2023-06-01",
    allowedRoles: ["admin", "manager"],
  },
];

const memberMap = new Map(MEMBERS.map((m) => [m.memberId, m]));

// ── MCP 서버 ──────────────────────────────────────────────

const server = new McpServer({
  name: "member-db",
  version: "1.0.0",
});

/** 회원사 정보 조회 */
server.tool(
  "getMemberInfo",
  "회원사 ID로 회원사 정보를 조회합니다.",
  { memberId: z.string().describe("회원사 식별자") },
  async ({ memberId }) => {
    const member = memberMap.get(memberId);
    if (!member) {
      return {
        content: [{ type: "text", text: JSON.stringify({ found: false, memberId }) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            found: true,
            memberId: member.memberId,
            name: member.name,
            status: member.status,
            contractStart: member.contractStart,
          }),
        },
      ],
    };
  }
);

/** 권한 확인 */
server.tool(
  "checkPermission",
  "회원사 ID와 역할(role)이 해당 기능 사용 권한을 갖는지 확인합니다.",
  {
    memberId: z.string().describe("회원사 식별자"),
    role: z.string().describe("요청자 역할"),
  },
  async ({ memberId, role }) => {
    const member = memberMap.get(memberId);
    if (!member) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              allowed: false,
              reason: `회원사 '${memberId}'가 존재하지 않습니다.`,
            }),
          },
        ],
      };
    }

    if (member.status !== "active") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              allowed: false,
              reason: `회원사 '${memberId}'의 계약이 비활성 상태입니다.`,
            }),
          },
        ],
      };
    }

    const allowed = member.allowedRoles.includes(role);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            allowed,
            reason: allowed
              ? undefined
              : `역할 '${role}'은 허용되지 않습니다. 허용 역할: ${member.allowedRoles.join(", ")}`,
          }),
        },
      ],
    };
  }
);

// ── 시작 ──────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
