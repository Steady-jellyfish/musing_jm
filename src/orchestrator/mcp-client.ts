/**
 * MCP 클라이언트 매니저
 *
 * erp-git / erp-db MCP 서버를 서브프로세스로 시작하고 stdio로 연결합니다.
 * Orchestrator가 Claude tool_use 루프 중 도구를 호출할 때 여기를 통합니다.
 *
 * 도구명 규칙 (Anthropic ↔ MCP 변환):
 *   MCP: 서버 "erp-git", 도구 "searchCode"
 *   Anthropic tool name: "erp_git__searchCode"  (하이픈→언더스코어, __ 구분자)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";
import { env } from "../config/env.js";

// ── 도구명 변환 헬퍼 ──────────────────────────────────────

function makeQualifiedName(serverName: string, toolName: string): string {
  return `${serverName.replace(/-/g, "_")}__${toolName}`;
}

function parseQualifiedName(
  qualifiedName: string
): { serverName: string; toolName: string } | null {
  const sep = qualifiedName.indexOf("__");
  if (sep === -1) return null;
  return {
    serverName: qualifiedName.slice(0, sep).replace(/_/g, "-"),
    toolName: qualifiedName.slice(sep + 2),
  };
}

// ── 서버 설정 타입 ────────────────────────────────────────

interface ServerConfig {
  /** StdioClientTransport에 전달할 command (Windows: cmd) */
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ConnectedServer {
  client: Client;
  /** Anthropic 형식 도구 목록 (name은 qualified name) */
  tools: Tool[];
}

/** /health 등에 노출할 MCP 서버별 상태 */
export interface McpServerStatus {
  name: string;
  status: "connected" | "skipped" | "error";
  /** 건너뜀/오류 이유 (status가 connected면 undefined) */
  reason?: string;
  /** 연결된 경우 도구 이름 목록 */
  tools?: string[];
}

// ── McpClientManager ──────────────────────────────────────

class McpClientManager {
  private servers = new Map<string, ConnectedServer>();
  private statuses: McpServerStatus[] = [];
  private initialized = false;

  /**
   * erp-git / erp-db MCP 서버를 시작하고 연결합니다.
   * 여러 번 호출해도 한 번만 초기화됩니다.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const isWin = process.platform === "win32";

    // 서버별로 "건너뜀 이유" 또는 "연결 설정"을 결정
    const candidates: Array<{
      name: string;
      skipReason: string | null;
      config: ServerConfig;
    }> = [
      {
        name: "erp-git",
        skipReason: process.env.ERP_GIT_URL ? null : "ERP_GIT_URL 없음",
        config: {
          command: isWin ? "cmd" : "npx",
          args: isWin
            ? ["/c", "npx", "tsx", "src/mcp-servers/erp-git/index.ts"]
            : ["tsx", "src/mcp-servers/erp-git/index.ts"],
          env: { ERP_GIT_CACHE_DIR: env.erpGitCacheDir },
        },
      },
      {
        name: "erp-db",
        skipReason: (() => {
          const missing = (
            [
              ["ERP_DB_HOST", env.erpDb.host],
              ["ERP_DB_NAME", env.erpDb.name],
              ["ERP_DB_USER", env.erpDb.user],
            ] as Array<[string, string]>
          )
            .filter(([, v]) => !v)
            .map(([k]) => k);
          return missing.length > 0 ? `${missing.join(", ")} 없음` : null;
        })(),
        config: {
          command: isWin ? "cmd" : "npx",
          args: isWin
            ? ["/c", "npx", "tsx", "src/mcp-servers/erp-db/index.ts"]
            : ["tsx", "src/mcp-servers/erp-db/index.ts"],
          env: {
            ERP_DB_HOST: env.erpDb.host,
            ERP_DB_PORT: String(env.erpDb.port),
            ERP_DB_NAME: env.erpDb.name,
            ERP_DB_USER: env.erpDb.user,
            ERP_DB_PASSWORD: env.erpDb.password,
            ERP_DB_QUERY_TIMEOUT_MS: String(env.erpDb.queryTimeoutMs),
          },
        },
      },
    ];

    for (const { name, skipReason, config } of candidates) {
      if (skipReason) {
        this.statuses.push({ name, status: "skipped", reason: skipReason });
        // 건너뜀은 경고 수준으로 출력
        process.stderr.write(`\x1b[33mWARN\x1b[0m [mcp-manager] ${name}: 건너뜀 (${skipReason})\n`);
        continue;
      }

      try {
        const toolNames = await this.connectServer(name, config);
        this.statuses.push({ name, status: "connected", tools: toolNames });
        process.stderr.write(`INFO [mcp-manager] ${name}: 연결됨 (도구: ${toolNames.join(", ")})\n`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.statuses.push({ name, status: "error", reason });
        process.stderr.write(`\x1b[33mWARN\x1b[0m [mcp-manager] ${name}: 연결 실패 — ${reason}\n`);
        // 개별 서버 실패는 전체 초기화를 막지 않음
      }
    }
  }

  /** 서버에 연결하고 도구명 목록을 반환합니다. */
  private async connectServer(name: string, config: ServerConfig): Promise<string[]> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });

    const client = new Client(
      { name: "orchestrator", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);

    // 도구 목록 조회 후 Anthropic 형식으로 변환
    const { tools: mcpTools } = await client.listTools();
    const anthropicTools: Tool[] = mcpTools.map((t) => ({
      name: makeQualifiedName(name, t.name),
      description: t.description ?? "",
      input_schema: t.inputSchema as Tool["input_schema"],
    }));

    this.servers.set(name, { client, tools: anthropicTools });
    return mcpTools.map((t) => t.name);
  }

  /** Claude에 전달할 Anthropic 형식 도구 목록을 반환합니다. */
  getTools(): Tool[] {
    const all: Tool[] = [];
    for (const { tools } of this.servers.values()) {
      all.push(...tools);
    }
    return all;
  }

  /**
   * Anthropic qualified tool name으로 MCP 도구를 호출합니다.
   * 결과를 { text, isError } 형태로 반환합니다.
   */
  async callTool(
    qualifiedName: string,
    input: Record<string, unknown>
  ): Promise<{ text: string; isError: boolean }> {
    const parsed = parseQualifiedName(qualifiedName);
    if (!parsed) {
      return { text: `알 수 없는 도구: ${qualifiedName}`, isError: true };
    }

    const server = this.servers.get(parsed.serverName);
    if (!server) {
      return {
        text: `서버 '${parsed.serverName}'에 연결되지 않았습니다. 환경변수를 확인하세요.`,
        isError: true,
      };
    }

    try {
      const result = await server.client.callTool({
        name: parsed.toolName,
        arguments: input,
      });

      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");

      return { text, isError: result.isError === true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `도구 호출 오류: ${msg}`, isError: true };
    }
  }

  /** 연결된 서버 이름 목록을 반환합니다. */
  connectedServers(): string[] {
    return [...this.servers.keys()];
  }

  /** /health 등에 노출할 MCP 서버별 상태 목록을 반환합니다. */
  getStatuses(): McpServerStatus[] {
    return this.statuses;
  }

  /** 모든 MCP 클라이언트 연결을 종료합니다. */
  async close(): Promise<void> {
    for (const [name, { client }] of this.servers) {
      try {
        await client.close();
      } catch {
        // 종료 오류는 무시
      }
      process.stderr.write(`[mcp-manager] ${name}: 연결 종료\n`);
    }
    this.servers.clear();
  }
}

// 모듈 레벨 싱글턴: 서버 전체에서 하나의 인스턴스만 사용
export const mcpManager = new McpClientManager();
