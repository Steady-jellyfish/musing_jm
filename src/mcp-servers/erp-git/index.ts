/**
 * ERP Git MCP 서버 — 로컬에 clone된 ERP 저장소 읽기 전용 접근
 *
 * 제공 도구:
 *   - listFiles    : 디렉토리 파일 목록/트리 조회
 *   - searchCode   : 키워드·정규식으로 코드 검색 (파일경로 + 라인번호 + 전후 2줄)
 *   - readFileRange: 파일 특정 라인 범위 읽기
 *
 * 보안:
 *   - 모든 경로는 ERP_GIT_ROOT 하위로만 제한 (path traversal 차단)
 *   - 쓰기 기능 없음
 *   - 결과 개수/라인 수 상한 강제
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import "dotenv/config";

// ── 설정 ──────────────────────────────────────────────────
const GIT_ROOT = path.resolve(process.env.ERP_GIT_ROOT ?? "");

const LIMITS = {
  listFiles: { maxDepth: 3, maxEntries: 500 },
  searchCode: { maxResults: 50, maxFileSizeBytes: 1 * 1024 * 1024, contextLines: 2 },
  readFileRange: { maxLines: 200 },
} as const;

// ── 경로 보안 ─────────────────────────────────────────────

/**
 * 입력 경로를 절대 경로로 변환하고, GIT_ROOT 하위인지 검증합니다.
 * path traversal(../ 등) 시도를 차단합니다.
 */
function resolveSafe(inputPath: string): string {
  if (!GIT_ROOT) {
    throw new Error("ERP_GIT_ROOT 환경변수가 설정되지 않았습니다.");
  }

  // inputPath가 절대경로면 그대로, 상대경로면 GIT_ROOT 기준으로 resolve
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(GIT_ROOT, inputPath);

  // GIT_ROOT의 자식인지 확인 (trailing separator로 prefix 검사)
  const normalizedRoot = GIT_ROOT.endsWith(path.sep) ? GIT_ROOT : GIT_ROOT + path.sep;
  if (resolved !== GIT_ROOT && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`경로 접근 거부: 허용 범위(${GIT_ROOT}) 밖의 경로입니다.`);
  }

  return resolved;
}

// ── glob 패턴 → 정규식 변환 ───────────────────────────────
// 지원 패턴: *, **, ? (기본 glob)
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")   // 특수문자 이스케이프
    .replace(/\*\*/g, "\x00STARSTAR\x00")    // ** 임시 치환
    .replace(/\*/g, "[^/\\\\]*")             // * → 디렉토리 구분자 제외 임의 문자
    .replace(/\x00STARSTAR\x00/g, ".*")      // ** → 임의 경로
    .replace(/\?/g, "[^/\\\\]");             // ? → 단일 문자
  return new RegExp(`(^|[/\\\\])${escaped}$`, "i");
}

// ── 파일 시스템 유틸 ──────────────────────────────────────

interface FileEntry {
  name: string;
  path: string;  // GIT_ROOT 기준 상대경로
  type: "file" | "dir";
  size?: number;
}

function listDir(dirPath: string, currentDepth: number, maxDepth: number): FileEntry[] {
  if (currentDepth > maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: FileEntry[] = [];
  for (const entry of entries) {
    // 숨김 파일·디렉토리 제외 (.git 포함)
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(GIT_ROOT, fullPath);

    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: relativePath, type: "dir" });
      if (currentDepth < maxDepth) {
        results.push(...listDir(fullPath, currentDepth + 1, maxDepth));
      }
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      results.push({ name: entry.name, path: relativePath, type: "file", size: stat.size });
    }
  }
  return results;
}

/** 디렉토리 트리를 재귀 탐색하며 파일 경로 목록 수집 */
function collectFiles(dirPath: string, fileGlobRegex: RegExp): string[] {
  const results: string[] = [];

  function walk(currentPath: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        // Windows 경로 구분자를 슬래시로 정규화해서 glob 패턴과 맞춤
        const relativePath = path.relative(GIT_ROOT, fullPath).replace(/\\/g, "/");
        if (fileGlobRegex.test(relativePath)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dirPath);
  return results;
}

interface SearchHit {
  file: string;   // GIT_ROOT 기준 상대경로
  line: number;
  matchedText: string;
  context: string[];  // 전후 2줄 포함 (라인 번호 표시)
}

/** 파일 하나를 라인 단위로 읽어 패턴 검색 */
async function searchInFile(
  filePath: string,
  pattern: RegExp,
  contextLines: number
): Promise<SearchHit[]> {
  const stat = fs.statSync(filePath);
  if (stat.size > LIMITS.searchCode.maxFileSizeBytes) return [];

  const hits: SearchHit[] = [];
  const lines: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => lines.push(line));
    rl.on("close", resolve);
    rl.on("error", reject);
  });

  const relativePath = path.relative(GIT_ROOT, filePath);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      const context = [];
      for (let j = start; j <= end; j++) {
        const prefix = j === i ? "→" : " ";
        context.push(`${prefix} ${j + 1}: ${lines[j]}`);
      }
      hits.push({
        file: relativePath,
        line: i + 1,
        matchedText: lines[i].trim(),
        context,
      });
    }
  }

  return hits;
}

// ── MCP 서버 정의 ─────────────────────────────────────────
const server = new McpServer({
  name: "erp-git-mcp",
  version: "0.1.0",
});

// ── Tool 1: listFiles ─────────────────────────────────────
server.tool(
  "listFiles",
  "ERP Git 저장소의 디렉토리 구조와 파일 목록을 조회합니다. 최대 depth 3, 숨김 파일(.git 등) 제외.",
  {
    path: z
      .string()
      .default("")
      .describe("조회할 경로 (저장소 루트 기준 상대경로, 비워두면 루트)"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.listFiles.maxDepth)
      .default(2)
      .describe(`탐색 깊이 (1~${LIMITS.listFiles.maxDepth})`),
    pattern: z
      .string()
      .optional()
      .describe("파일명 필터 패턴 (예: *.java, *.xml)"),
  },
  async ({ path: inputPath, depth, pattern }) => {
    let resolvedPath: string;
    try {
      resolvedPath = resolveSafe(inputPath);
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
    }

    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `경로를 찾을 수 없습니다: ${inputPath}` }) }], isError: true };
    }

    let entries = listDir(resolvedPath, 0, depth);

    // 패턴 필터 적용
    if (pattern) {
      const regex = globToRegex(pattern);
      entries = entries.filter((e) => e.type === "dir" || regex.test(e.name));
    }

    // 상한 적용
    const truncated = entries.length > LIMITS.listFiles.maxEntries;
    if (truncated) entries = entries.slice(0, LIMITS.listFiles.maxEntries);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              root: inputPath || "(저장소 루트)",
              totalEntries: entries.length,
              truncated,
              entries,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool 2: searchCode ────────────────────────────────────
server.tool(
  "searchCode",
  "ERP Git 저장소에서 키워드 또는 정규식으로 코드를 검색합니다. 파일경로·라인번호·전후 2줄 컨텍스트를 반환합니다.",
  {
    pattern: z.string().describe("검색할 키워드 또는 정규식 (예: PKG_SU_CALC, calcFee\\()"),
    fileGlob: z
      .string()
      .default("**/*")
      .describe("검색 대상 파일 glob 패턴 (예: **/*.java, src/**/*.ts)"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.searchCode.maxResults)
      .default(20)
      .describe(`최대 반환 결과 수 (1~${LIMITS.searchCode.maxResults})`),
    searchPath: z
      .string()
      .default("")
      .describe("검색 시작 경로 (저장소 루트 기준 상대경로, 비워두면 전체)"),
  },
  async ({ pattern, fileGlob, maxResults, searchPath }) => {
    let searchRegex: RegExp;
    try {
      searchRegex = new RegExp(pattern, "i");
    } catch {
      return { content: [{ type: "text", text: JSON.stringify({ error: `유효하지 않은 정규식: ${pattern}` }) }], isError: true };
    }

    let resolvedSearchPath: string;
    try {
      resolvedSearchPath = resolveSafe(searchPath);
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
    }

    const fileGlobRegex = globToRegex(fileGlob);
    const files = collectFiles(resolvedSearchPath, fileGlobRegex);

    const hits: SearchHit[] = [];
    for (const file of files) {
      if (hits.length >= maxResults) break;
      try {
        const fileHits = await searchInFile(file, searchRegex, LIMITS.searchCode.contextLines);
        for (const hit of fileHits) {
          hits.push(hit);
          if (hits.length >= maxResults) break;
        }
      } catch {
        // 읽기 실패 파일은 무시
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pattern,
              fileGlob,
              scannedFiles: files.length,
              hitCount: hits.length,
              truncated: hits.length >= maxResults,
              results: hits,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool 3: readFileRange ─────────────────────────────────
server.tool(
  "readFileRange",
  "ERP Git 저장소의 파일을 지정한 라인 범위로 읽습니다. 한 번에 최대 200줄.",
  {
    path: z.string().describe("파일 경로 (저장소 루트 기준 상대경로)"),
    lineStart: z.number().int().min(1).describe("시작 라인 번호 (1부터)"),
    lineEnd: z.number().int().min(1).describe("종료 라인 번호"),
  },
  async ({ path: inputPath, lineStart, lineEnd }) => {
    // 라인 범위 상한 강제
    const clampedEnd = Math.min(lineEnd, lineStart + LIMITS.readFileRange.maxLines - 1);

    let resolvedPath: string;
    try {
      resolvedPath = resolveSafe(inputPath);
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
    }

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `파일을 찾을 수 없습니다: ${inputPath}` }) }], isError: true };
    }

    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const rl = readline.createInterface({
        input: fs.createReadStream(resolvedPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      let lineNum = 0;
      rl.on("line", (line) => {
        lineNum++;
        if (lineNum >= lineStart && lineNum <= clampedEnd) {
          lines.push(`${lineNum}: ${line}`);
        }
        if (lineNum > clampedEnd) rl.close();
      });
      rl.on("close", resolve);
      rl.on("error", reject);
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              file: inputPath,
              requestedRange: { lineStart, lineEnd },
              actualRange: { lineStart, lineEnd: clampedEnd },
              truncated: clampedEnd < lineEnd,
              content: lines.join("\n"),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── 서버 시작 ─────────────────────────────────────────────
if (!GIT_ROOT) {
  process.stderr.write("[erp-git-mcp] 경고: ERP_GIT_ROOT가 설정되지 않았습니다.\n");
} else {
  process.stderr.write(`[erp-git-mcp] Git 루트: ${GIT_ROOT}\n`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
