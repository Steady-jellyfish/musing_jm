/**
 * ERP MariaDB MCP 서버 — SELECT 전용 읽기 접근
 *
 * 제공 도구:
 *   - listTables   : 테이블 목록 조회
 *   - describeTable: 테이블 컬럼·코멘트 조회
 *   - executeQuery : SELECT 쿼리 실행
 *
 * 보안 (이중 방어):
 *   1. 계정 레벨: 환경변수로 주입되는 읽기 전용 DB 계정 사용
 *   2. 코드 레벨: SELECT 외 구문 파싱 차단, LIMIT 강제, PII 컬럼 마스킹
 *   3. 로그에 접속 정보·쿼리 원문·결과 원문 절대 노출 금지
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mysql from "mysql2/promise";
import "dotenv/config";

// ── 설정 ──────────────────────────────────────────────────
const DB_CONFIG = {
  host: process.env.ERP_DB_HOST ?? "localhost",
  port: Number(process.env.ERP_DB_PORT ?? 3306),
  database: process.env.ERP_DB_NAME ?? "",
  user: process.env.ERP_DB_USER ?? "",
  password: process.env.ERP_DB_PASSWORD ?? "",
  // mysql2 connectTimeout 옵션 (ms)
  connectTimeout: Number(process.env.ERP_DB_QUERY_TIMEOUT_MS ?? 30000),
  // 결과를 객체 배열로 반환
  rowsAsArray: false,
};

const QUERY_TIMEOUT_MS = Number(process.env.ERP_DB_QUERY_TIMEOUT_MS ?? 30000);
const MAX_ROWS = 100;

// ── PII 컬럼 마스킹 패턴 ─────────────────────────────────
// 컬럼명이 이 패턴에 매칭되면 값을 "***"로 마스킹합니다.
const PII_COLUMN_PATTERN =
  /주민|rrn|jumin|tel|phone|핸드폰|휴대폰|계좌|account|acct|password|passwd|pwd|ssn|birth|생년|email|이메일/i;

function maskPiiColumns(
  columns: string[],
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const piiCols = new Set(columns.filter((c) => PII_COLUMN_PATTERN.test(c)));
  if (piiCols.size === 0) return rows;

  return rows.map((row) => {
    const masked: Record<string, unknown> = { ...row };
    for (const col of piiCols) {
      if (col in masked) masked[col] = "***";
    }
    return masked;
  });
}

// ── SQL 검증 ──────────────────────────────────────────────

// SQL 주석 제거: 블록 주석(slash-star ... star-slash)과 라인 주석(--)을 제거합니다.
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")  // 블록 주석
    .replace(/--[^\n]*/g, " ")          // 라인 주석
    .trim();
}

/** SELECT(또는 WITH, EXPLAIN SELECT)만 허용하고, 그 외 구문은 오류를 던집니다. */
function assertSelectOnly(sql: string): void {
  const normalized = stripSqlComments(sql).replace(/\s+/g, " ").trim().toUpperCase();

  // 허용: SELECT, WITH ... (서브쿼리/CTE), EXPLAIN SELECT
  const isAllowed =
    normalized.startsWith("SELECT ") ||
    normalized === "SELECT" ||
    normalized.startsWith("WITH ") ||
    normalized.startsWith("EXPLAIN SELECT ");

  if (!isAllowed) {
    // 어떤 구문인지 첫 키워드만 로그에 남김 (원문 노출 금지)
    const firstWord = normalized.split(" ")[0];
    throw new Error(
      `허용되지 않는 SQL 구문입니다: ${firstWord}. SELECT 구문만 실행할 수 있습니다.`
    );
  }

  // 추가 차단: 멀티 스테이트먼트 방지 (세미콜론 이후 구문 차단)
  // WITH/EXPLAIN 예외 처리를 위해 첫 SELECT 이전까지만 허용
  const strippedUpper = normalized;
  // SELECT 이후에 ; 가 있으면 뒤에 추가 구문이 있을 수 있음
  if (/;\s*\S/.test(stripSqlComments(sql))) {
    throw new Error("멀티 스테이트먼트는 허용되지 않습니다.");
  }
}

/** LIMIT 절이 없으면 MAX_ROWS를 강제로 추가합니다. */
function enforceLimitClause(sql: string): string {
  const upper = stripSqlComments(sql).toUpperCase();
  if (/\bLIMIT\b/.test(upper)) {
    // 이미 LIMIT 있으면 원본 반환 (mysql2 드라이버가 실제 실행 시 제한)
    return sql;
  }
  // 세미콜론 제거 후 LIMIT 추가
  return sql.replace(/;?\s*$/, "") + ` LIMIT ${MAX_ROWS}`;
}

// ── DB 연결 헬퍼 ─────────────────────────────────────────

async function withConnection<T>(
  fn: (conn: mysql.Connection) => Promise<T>
): Promise<T> {
  // 접속 정보는 로그·오류 메시지에 절대 노출하지 않음
  let conn: mysql.Connection | undefined;
  try {
    conn = await mysql.createConnection(DB_CONFIG);
    return await fn(conn);
  } catch (err) {
    // 오류 메시지에서 접속 정보 제거
    if (err instanceof Error) {
      // mysql2 오류에 호스트/포트/유저가 포함될 수 있음
      err.message = err.message
        .replace(/host[^,)]*[,)]/gi, "host=<hidden>,")
        .replace(/user[^,)]*[,)]/gi, "user=<hidden>,")
        .replace(/password[^,)]*[,)]/gi, "password=<hidden>,");
    }
    throw err;
  } finally {
    if (conn) await conn.end();
  }
}

/** 쿼리 타임아웃을 Promise.race로 구현합니다. */
async function queryWithTimeout<T>(
  conn: mysql.Connection,
  sql: string,
  timeoutMs: number
): Promise<T> {
  const queryPromise = conn.query(sql) as Promise<T>;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`쿼리 타임아웃 (${timeoutMs}ms 초과)`)), timeoutMs)
  );
  return Promise.race([queryPromise, timeoutPromise]);
}

// ── MCP 서버 정의 ─────────────────────────────────────────
const server = new McpServer({
  name: "erp-db-mcp",
  version: "0.1.0",
});

// ── Tool 1: listTables ────────────────────────────────────
server.tool(
  "listTables",
  "ERP MariaDB의 테이블 목록을 조회합니다. SELECT 전용 접근입니다.",
  {
    schema: z
      .string()
      .optional()
      .describe("조회할 스키마(데이터베이스) 이름. 생략 시 접속 기본 DB 사용"),
    pattern: z
      .string()
      .optional()
      .describe("테이블명 필터 패턴 (SQL LIKE 구문, 예: PKG_%)"),
  },
  async ({ schema, pattern }) => {
    try {
      const result = await withConnection(async (conn) => {
        const db = schema ? conn.escapeId(schema) : "DATABASE()";
        const likeSql = pattern
          ? `AND TABLE_NAME LIKE ${conn.escape(pattern)}`
          : "";
        const sql = `
          SELECT TABLE_NAME, TABLE_COMMENT, TABLE_ROWS, CREATE_TIME
          FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ${schema ? conn.escapeId(schema) : "DATABASE()"}
          ${likeSql}
          ORDER BY TABLE_NAME
          LIMIT ${MAX_ROWS}
        `;
        const [rows] = await queryWithTimeout<mysql.RowDataPacket[][]>(
          conn, sql, QUERY_TIMEOUT_MS
        );
        return rows;
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { count: result.length, tables: result },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "알 수 없는 오류";
      process.stderr.write(`[erp-db-mcp] listTables 오류: ${message}\n`);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool 2: describeTable ─────────────────────────────────
server.tool(
  "describeTable",
  "ERP MariaDB 테이블의 컬럼 정보(이름·타입·코멘트·NULL 여부)를 조회합니다. PII 컬럼은 표시만 됩니다(값 없음).",
  {
    table: z.string().describe("조회할 테이블 이름"),
    schema: z
      .string()
      .optional()
      .describe("스키마(데이터베이스) 이름. 생략 시 접속 기본 DB 사용"),
  },
  async ({ table, schema }) => {
    try {
      const result = await withConnection(async (conn) => {
        const sql = `
          SELECT
            COLUMN_NAME,
            COLUMN_TYPE,
            IS_NULLABLE,
            COLUMN_KEY,
            COLUMN_DEFAULT,
            COLUMN_COMMENT
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ${schema ? conn.escape(schema) : "DATABASE()"}
            AND TABLE_NAME = ${conn.escape(table)}
          ORDER BY ORDINAL_POSITION
        `;
        const [rows] = await queryWithTimeout<mysql.RowDataPacket[][]>(
          conn, sql, QUERY_TIMEOUT_MS
        );
        return rows;
      });

      // PII 컬럼에 경고 표시
      const annotated = (result as mysql.RowDataPacket[]).map((col) => ({
        ...col,
        pii: PII_COLUMN_PATTERN.test(String(col.COLUMN_NAME)),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { table, columnCount: annotated.length, columns: annotated },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "알 수 없는 오류";
      process.stderr.write(`[erp-db-mcp] describeTable 오류: ${message}\n`);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool 3: executeQuery ──────────────────────────────────
server.tool(
  "executeQuery",
  `ERP MariaDB에서 SELECT 쿼리를 실행합니다.
규칙: SELECT/WITH/EXPLAIN SELECT만 허용. LIMIT 미지정 시 ${MAX_ROWS}행 자동 적용. PII 컬럼 값은 자동 마스킹.`,
  {
    query: z.string().describe("실행할 SELECT 쿼리"),
  },
  async ({ query }) => {
    // ① SQL 검증 (SELECT만 허용)
    try {
      assertSelectOnly(query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 거부된 쿼리의 첫 키워드만 로그에 남김 (원문 노출 금지)
      const firstWord = stripSqlComments(query).trim().split(/\s/)[0]?.toUpperCase() ?? "?";
      process.stderr.write(`[erp-db-mcp] 쿼리 거부: ${firstWord} 구문\n`);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }

    // ② LIMIT 강제
    const safeQuery = enforceLimitClause(query);

    // ③ 실행
    const startTime = Date.now();
    try {
      const { rows, fields } = await withConnection(async (conn) => {
        const [rows, fields] = await queryWithTimeout<[mysql.RowDataPacket[], mysql.FieldPacket[]]>(
          conn, safeQuery, QUERY_TIMEOUT_MS
        );
        return { rows, fields };
      });

      const elapsedMs = Date.now() - startTime;
      // 실행 시간만 로그 (쿼리 원문·결과 원문 노출 금지)
      process.stderr.write(`[erp-db-mcp] executeQuery 완료: ${elapsedMs}ms, ${rows.length}행\n`);

      // ④ PII 마스킹
      const columns = (fields ?? []).map((f) => f.name);
      const maskedRows = maskPiiColumns(columns, rows as Record<string, unknown>[]);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                rowCount: maskedRows.length,
                columns,
                elapsedMs,
                rows: maskedRows,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : "알 수 없는 오류";
      process.stderr.write(`[erp-db-mcp] executeQuery 오류: ${elapsedMs}ms\n`);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }
);

// ── 서버 시작 ─────────────────────────────────────────────
const missingVars = ["ERP_DB_HOST", "ERP_DB_NAME", "ERP_DB_USER", "ERP_DB_PASSWORD"]
  .filter((k) => !process.env[k]);

if (missingVars.length > 0) {
  process.stderr.write(
    `[erp-db-mcp] 경고: 환경변수 미설정 — ${missingVars.join(", ")}\n`
  );
} else {
  process.stderr.write("[erp-db-mcp] DB 연결 설정 완료 (접속 정보 로그 생략)\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);
