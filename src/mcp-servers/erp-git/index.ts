/**
 * ERP Git MCP 서버 — Git URL 기반 캐시 저장소 읽기 전용 접근
 *
 * 제공 도구:
 *   - listFiles     : 디렉토리 파일 목록/트리 조회
 *   - searchCode    : 키워드·정규식으로 코드 검색 (파일경로 + 라인번호 + 전후 2줄)
 *   - readFileRange : 파일 특정 라인 범위 읽기
 *
 * 공통 파라미터:
 *   - repo (선택): config/repos.json의 id. 생략 시 첫 번째 저장소 사용.
 *
 * 보안:
 *   - 모든 경로는 ERP_GIT_CACHE_DIR 하위로만 제한 (path traversal 차단)
 *   - 쓰기 기능 없음
 *   - 결과 개수/라인 수 상한 강제
 *
 * 저장소 동기화(clone/fetch)는 메인 프로세스(src/git-sync/repo-manager.ts)가 담당.
 * 이 서버는 캐시 경로를 읽기만 합니다.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import "dotenv/config";

// ── 설정 ──────────────────────────────────────────────────

interface RepoConfig {
  id: string;
  urlEnv: string;
  branchEnv: string;
  description?: string;
}

function loadReposConfig(): RepoConfig[] {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  // src/mcp-servers/erp-git/ → ../../../ → 프로젝트 루트 → config/repos.json
  const configPath = path.resolve(thisDir, "../../../config/repos.json");
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as RepoConfig[];
}

const repos = loadReposConfig();
const CACHE_DIR = path.resolve(process.env.ERP_GIT_CACHE_DIR ?? "./.cache/repos");

const LIMITS = {
  listFiles: { maxDepth: 3, maxEntries: 500 },
  searchCode: { maxResults: 50, maxFileSizeBytes: 1 * 1024 * 1024, contextLines: 2 },
  readFileRange: { maxLines: 200 },
} as const;

// ── 저장소 경로 해석 ──────────────────────────────────────

/**
 * repo ID → 로컬 캐시 경로를 반환합니다.
 * repo 미지정 시 첫 번째 저장소를 사용합니다.
 */
function resolveRepoRoot(repoId?: string): { id: string; root: string } {
  const id = repoId ?? repos[0]?.id;
  if (!id) throw new Error("등록된 저장소가 없습니다. config/repos.json을 확인하세요.");

  const repo = repos.find((r) => r.id === id);
  if (!repo) throw new Error(`알 수 없는 저장소 ID: '${id}'. 등록된 ID: ${repos.map((r) => r.id).join(", ")}`);

  const root = path.resolve(CACHE_DIR, id);

  if (!fs.existsSync(root)) {
    throw new Error(
      `저장소 '${id}' 캐시가 없습니다. 동기화 중이거나 ERP_GIT_URL이 설정되지 않았을 수 있습니다.`
    );
  }

  return { id, root };
}

// ── 경로 보안 ─────────────────────────────────────────────

/**
 * 입력 경로를 절대 경로로 변환하고 repoRoot 하위인지 검증합니다.
 * path traversal(../ 등) 시도를 차단합니다.
 */
function resolveSafe(repoRoot: string, inputPath: string): string {
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(repoRoot, inputPath);

  const normalizedRoot = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (resolved !== repoRoot && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`경로 접근 거부: 허용 범위(${repoRoot}) 밖의 경로입니다.`);
  }

  return resolved;
}

// ── glob 패턴 → 정규식 변환 ───────────────────────────────

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00STARSTAR\x00")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\x00STARSTAR\x00/g, ".*")
    .replace(/\?/g, "[^/\\\\]");
  return new RegExp(`(^|[/\\\\])${escaped}$`, "i");
}

// ── 파일 시스템 유틸 ──────────────────────────────────────

interface FileEntry {
  name: string;
  path: string;   // repoRoot 기준 상대경로
  type: "file" | "dir";
  size?: number;
}

function listDir(repoRoot: string, dirPath: string, currentDepth: number, maxDepth: number): FileEntry[] {
  if (currentDepth > maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(repoRoot, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: relativePath, type: "dir" });
      if (currentDepth < maxDepth) {
        results.push(...listDir(repoRoot, fullPath, currentDepth + 1, maxDepth));
      }
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      results.push({ name: entry.name, path: relativePath, type: "file", size: stat.size });
    }
  }
  return results;
}

function collectFiles(repoRoot: string, dirPath: string, fileGlobRegex: RegExp): string[] {
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
        const relativePath = path.relative(repoRoot, fullPath).replace(/\\/g, "/");
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
  file: string;        // repoRoot 기준 상대경로
  line: number;
  matchedText: string;
  context: string[];   // 전후 2줄 포함
}

async function searchInFile(
  repoRoot: string,
  filePath: string,
  pattern: RegExp,
  contextLines: number
): Promise<SearchHit[]> {
  const stat = fs.statSync(filePath);
  if (stat.size > LIMITS.searchCode.maxFileSizeBytes) return [];

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

  const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  const hits: SearchHit[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      const context: string[] = [];
      for (let j = start; j <= end; j++) {
        context.push(`${j === i ? "→" : " "} ${j + 1}: ${lines[j]}`);
      }
      hits.push({ file: relativePath, line: i + 1, matchedText: lines[i].trim(), context });
    }
  }

  return hits;
}

// ── 공통 repo 파라미터 스키마 ─────────────────────────────

const repoParam = z
  .string()
  .optional()
  .describe(`저장소 ID (config/repos.json의 id). 생략 시 첫 번째 저장소(${repos[0]?.id ?? "없음"}) 사용.`);

// ── MCP 서버 정의 ─────────────────────────────────────────

const server = new McpServer({ name: "erp-git-mcp", version: "1.0.0" });

// ── Tool 1: listFiles ─────────────────────────────────────

server.tool(
  "listFiles",
  "ERP Git 저장소의 디렉토리 구조와 파일 목록을 조회합니다. 최대 depth 3, 숨김 파일(.git 등) 제외.",
  {
    repo: repoParam,
    path: z.string().default("").describe("조회할 경로 (저장소 루트 기준 상대경로, 비워두면 루트)"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.listFiles.maxDepth)
      .default(2)
      .describe(`탐색 깊이 (1~${LIMITS.listFiles.maxDepth})`),
    pattern: z.string().optional().describe("파일명 필터 패턴 (예: *.java, *.xml)"),
  },
  async ({ repo, path: inputPath, depth, pattern }) => {
    let repoRoot: string;
    let repoId: string;
    try {
      ({ id: repoId, root: repoRoot } = resolveRepoRoot(repo));
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
    }

    let resolvedPath: string;
    try {
      resolvedPath = resolveSafe(repoRoot, inputPath);
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
    }

    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `경로를 찾을 수 없습니다: ${inputPath}` }) }], isError: true };
    }

    let entries = listDir(repoRoot, resolvedPath, 0, depth);
    if (pattern) {
      const regex = globToRegex(pattern);
      entries = entries.filter((e) => e.type === "dir" || regex.test(e.name));
    }

    const truncated = entries.length > LIMITS.listFiles.maxEntries;
    if (truncated) entries = entries.slice(0, LIMITS.listFiles.maxEntries);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ repo: repoId, root: inputPath || "(저장소 루트)", totalEntries: entries.length, truncated, entries }, null, 2),
      }],
    };
  }
);

// ── Tool 2: searchCode ────────────────────────────────────

server.tool(
  "searchCode",
  "ERP Git 저장소에서 키워드 또는 정규식으로 코드를 검색합니다. 파일경로·라인번호·전후 2줄 컨텍스트를 반환합니다.",
  {
    repo: repoParam,
    pattern: z.string().describe("검색할 키워드 또는 정규식 (예: PKG_SU_CALC, calcFee\\()"),
    fileGlob: z.string().default("**/*").describe("검색 대상 파일 glob 패턴 (예: **/*.java, src/**/*.ts)"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.searchCode.maxResults)
      .default(20)
      .describe(`최대 반환 결과 수 (1~${LIMITS.searchCode.maxResults})`),
    searchPath: z.string().default("").describe("검색 시작 경로 (저장소 루트 기준 상대경로, 비워두면 전체)"),
  },
  async ({ repo, pattern, fileGlob, maxResults, searchPath }) => {
    let repoRoot: string;
    let repoId: string;
    try {
      ({ id: repoId, root: repoRoot } = resolveRepoRoot(repo));
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
    }

    let searchRegex: RegExp;
    try {
      searchRegex = new RegExp(pattern, "i");
    } catch {
      return { content: [{ type: "text", text: JSON.stringify({ error: `유효하지 않은 정규식: ${pattern}` }) }], isError: true };
    }

    let resolvedSearchPath: string;
    try {
      resolvedSearchPath = resolveSafe(repoRoot, searchPath);
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
    }

    const files = collectFiles(repoRoot, resolvedSearchPath, globToRegex(fileGlob));
    const hits: SearchHit[] = [];

    for (const file of files) {
      if (hits.length >= maxResults) break;
      try {
        const fileHits = await searchInFile(repoRoot, file, searchRegex, LIMITS.searchCode.contextLines);
        for (const hit of fileHits) {
          hits.push(hit);
          if (hits.length >= maxResults) break;
        }
      } catch {
        // 읽기 실패 파일은 무시
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ repo: repoId, pattern, fileGlob, scannedFiles: files.length, hitCount: hits.length, truncated: hits.length >= maxResults, results: hits }, null, 2),
      }],
    };
  }
);

// ── Tool 3: readFileRange ─────────────────────────────────

server.tool(
  "readFileRange",
  "ERP Git 저장소의 파일을 지정한 라인 범위로 읽습니다. 한 번에 최대 200줄.",
  {
    repo: repoParam,
    path: z.string().describe("파일 경로 (저장소 루트 기준 상대경로)"),
    lineStart: z.number().int().min(1).describe("시작 라인 번호 (1부터)"),
    lineEnd: z.number().int().min(1).describe("종료 라인 번호"),
  },
  async ({ repo, path: inputPath, lineStart, lineEnd }) => {
    let repoRoot: string;
    let repoId: string;
    try {
      ({ id: repoId, root: repoRoot } = resolveRepoRoot(repo));
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true };
    }

    const clampedEnd = Math.min(lineEnd, lineStart + LIMITS.readFileRange.maxLines - 1);

    let resolvedPath: string;
    try {
      resolvedPath = resolveSafe(repoRoot, inputPath);
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
        if (lineNum >= lineStart && lineNum <= clampedEnd) lines.push(`${lineNum}: ${line}`);
        if (lineNum > clampedEnd) rl.close();
      });
      rl.on("close", resolve);
      rl.on("error", reject);
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          repo: repoId,
          file: inputPath,
          requestedRange: { lineStart, lineEnd },
          actualRange: { lineStart, lineEnd: clampedEnd },
          truncated: clampedEnd < lineEnd,
          content: lines.join("\n"),
        }, null, 2),
      }],
    };
  }
);

// ── 서버 시작 ─────────────────────────────────────────────

process.stderr.write(
  `[erp-git-mcp] 시작. 캐시 경로: ${CACHE_DIR}, 저장소: ${repos.map((r) => r.id).join(", ") || "없음"}\n`
);

const transport = new StdioServerTransport();
await server.connect(transport);
