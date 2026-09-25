/**
 * Git 저장소 동기화 매니저 (메인 프로세스 전용)
 *
 * - 기동 시 config/repos.json을 읽어 각 저장소를 비동기로 clone/fetch
 * - 서버 기동을 막지 않음: 첫 clone 포함 모든 동기화는 fire-and-forget
 * - fetch/reset 실패 시 기존 캐시로 동작하며 상태를 "stale"로 표시
 * - GIT_TERMINAL_PROMPT=0으로 인증 프롬프트 비활성화 (실패 시 즉시 종료)
 *
 * 주기적 동기화 추가 방법:
 *   startPeriodicSync(intervalMs) 메서드를 구현 후 src/index.ts에서 호출.
 *   현재는 stub 주석으로 위치 표시.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import type { RepoConfig, RepoStatus } from "./types.js";

const execFileAsync = promisify(execFile);

// ── 설정 로드 ──────────────────────────────────────────────

function loadReposConfig(): RepoConfig[] {
  // 이 파일 위치: src/git-sync/repo-manager.ts
  // repos.json 위치: config/repos.json (프로젝트 루트)
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.resolve(thisDir, "../../config/repos.json");
  return JSON.parse(readFileSync(configPath, "utf-8")) as RepoConfig[];
}

// ── git 실행 헬퍼 ──────────────────────────────────────────

interface GitError extends Error {
  stderr?: string;
  stdout?: string;
}

function extractGitError(err: unknown): string {
  if (err instanceof Error) {
    const ge = err as GitError;
    const stderr = ge.stderr?.trim();
    return stderr ? `${err.message}\n${stderr.slice(0, 300)}` : err.message;
  }
  return String(err);
}

async function runGit(
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",   // 인증 프롬프트 비활성화 → 실패 시 즉시 종료
    },
    timeout: 60_000,
  });
}

// ── RepoSyncManager ───────────────────────────────────────

class RepoSyncManager {
  private repos: RepoConfig[] = [];
  private statuses = new Map<string, RepoStatus>();
  private readonly cacheDir: string;

  constructor() {
    this.cacheDir = path.resolve(env.erpGitCacheDir);
  }

  /**
   * repos.json을 읽고 각 저장소 동기화를 비동기로 시작합니다.
   * await해도 즉시 반환됩니다 (동기화는 백그라운드에서 진행).
   */
  async initialize(): Promise<void> {
    try {
      this.repos = loadReposConfig();
    } catch (err) {
      process.stderr.write(`WARN [git-sync] repos.json 로드 실패: ${extractGitError(err)}\n`);
      return;
    }

    for (const repo of this.repos) {
      const url = process.env[repo.urlEnv] ?? "";

      if (!url) {
        this.statuses.set(repo.id, {
          id: repo.id,
          description: repo.description,
          status: "missing",
          warning: `${repo.urlEnv} 환경변수가 설정되지 않았습니다.`,
        });
        process.stderr.write(
          `WARN [git-sync] ${repo.id}: 건너뜀 (${repo.urlEnv} 없음)\n`
        );
        continue;
      }

      // 상태를 syncing으로 설정하고 비동기 시작 (서버 기동 차단 안 함)
      this.statuses.set(repo.id, {
        id: repo.id,
        description: repo.description,
        status: "syncing",
      });

      this.syncRepo(repo.id).catch((err) => {
        // syncRepo 내부에서 대부분 처리하지만 예상치 못한 오류 대비
        process.stderr.write(
          `WARN [git-sync] ${repo.id}: 예상치 못한 오류 — ${extractGitError(err)}\n`
        );
      });
    }
  }

  /**
   * 저장소 하나를 동기화합니다.
   * - 캐시 없음: git clone --depth 1 --branch {branch} {url}
   * - 캐시 있음: git fetch origin → git reset --hard origin/{branch}
   * - fetch 실패: 기존 캐시 유지, status="stale"
   * - clone 실패: status="stale", warning 기록
   * 내부에서 모든 오류를 처리하므로 일반적으로 throw하지 않습니다.
   */
  async syncRepo(id: string): Promise<void> {
    const repo = this.repos.find((r) => r.id === id);
    if (!repo) throw new Error(`알 수 없는 저장소 ID: ${id}`);

    const url = process.env[repo.urlEnv] ?? "";
    const branch = process.env[repo.branchEnv] ?? "main";
    const localPath = path.resolve(this.cacheDir, id);

    // ── 보안: localPath가 cacheDir 하위인지 검증 ──
    this.assertUnderCacheDir(localPath);

    // cacheDir 생성
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }

    if (!existsSync(localPath)) {
      await this.cloneRepo(repo, url, branch, localPath);
    } else {
      await this.fetchAndReset(repo, branch, localPath);
    }
  }

  private async cloneRepo(
    repo: RepoConfig,
    url: string,
    branch: string,
    localPath: string
  ): Promise<void> {
    process.stderr.write(
      `INFO [git-sync] ${repo.id}: git clone 시작 (branch: ${branch})\n`
    );
    try {
      await runGit(["clone", "--depth", "1", "--branch", branch, url, localPath]);
      this.statuses.set(repo.id, {
        id: repo.id,
        description: repo.description,
        status: "synced",
        syncedAt: new Date().toISOString(),
      });
      process.stderr.write(`INFO [git-sync] ${repo.id}: clone 완료\n`);
    } catch (err) {
      const msg = extractGitError(err);
      this.statuses.set(repo.id, {
        id: repo.id,
        description: repo.description,
        status: "stale",
        warning: `clone 실패: ${msg.slice(0, 300)}`,
      });
      process.stderr.write(`WARN [git-sync] ${repo.id}: clone 실패 — ${msg}\n`);
    }
  }

  private async fetchAndReset(
    repo: RepoConfig,
    branch: string,
    localPath: string
  ): Promise<void> {
    process.stderr.write(`INFO [git-sync] ${repo.id}: git fetch 시작\n`);

    try {
      await runGit(["fetch", "origin"], localPath);
    } catch (err) {
      // fetch 실패 → 기존 캐시 유지
      const msg = extractGitError(err);
      const prev = this.statuses.get(repo.id);
      this.statuses.set(repo.id, {
        ...prev,
        id: repo.id,
        status: "stale",
        warning: `fetch 실패, 기존 캐시 사용 중: ${msg.slice(0, 300)}`,
      });
      process.stderr.write(
        `WARN [git-sync] ${repo.id}: fetch 실패 (기존 캐시 사용) — ${msg}\n`
      );
      return;
    }

    // reset --hard (cacheDir 하위 검증은 위에서 이미 완료)
    try {
      await runGit(["reset", "--hard", `origin/${branch}`], localPath);
      this.statuses.set(repo.id, {
        id: repo.id,
        description: repo.description,
        status: "synced",
        syncedAt: new Date().toISOString(),
      });
      process.stderr.write(
        `INFO [git-sync] ${repo.id}: 최신화 완료 (origin/${branch})\n`
      );
    } catch (err) {
      const msg = extractGitError(err);
      const prev = this.statuses.get(repo.id);
      this.statuses.set(repo.id, {
        ...prev,
        id: repo.id,
        status: "stale",
        warning: `reset --hard 실패: ${msg.slice(0, 300)}`,
      });
      process.stderr.write(`WARN [git-sync] ${repo.id}: reset 실패 — ${msg}\n`);
    }
  }

  /**
   * 모든 저장소를 동기화합니다.
   * 주기적 동기화 또는 수동 갱신 트리거로 사용합니다.
   */
  async syncAll(): Promise<void> {
    await Promise.allSettled(
      this.repos
        .filter((r) => (process.env[r.urlEnv] ?? "") !== "")
        .map((r) => this.syncRepo(r.id))
    );
  }

  /**
   * 주기적 동기화 (미구현 — 나중에 활성화)
   *
   * 사용 예시 (src/index.ts에 추가):
   *   repoSyncManager.startPeriodicSync(60 * 60 * 1000); // 1시간마다
   */
  // startPeriodicSync(intervalMs: number): NodeJS.Timeout {
  //   return setInterval(() => {
  //     this.syncAll().catch((err) =>
  //       process.stderr.write(`WARN [git-sync] 주기 동기화 오류: ${err.message}\n`)
  //     );
  //   }, intervalMs);
  // }

  /** /health에 노출할 저장소별 동기화 상태 목록 */
  getStatuses(): RepoStatus[] {
    return [...this.statuses.values()];
  }

  /** 저장소 ID로 로컬 캐시 경로를 반환합니다. */
  getLocalPath(id: string): string {
    return path.resolve(this.cacheDir, id);
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  // ── 내부 보안 검증 ────────────────────────────────────────

  private assertUnderCacheDir(targetPath: string): void {
    const resolved = path.resolve(targetPath);
    const resolvedCache = path.resolve(this.cacheDir);
    const isUnder =
      resolved === resolvedCache ||
      resolved.startsWith(resolvedCache + path.sep);

    if (!isUnder) {
      throw new Error(
        `보안 오류: 대상 경로가 캐시 디렉토리 밖입니다.\n` +
          `  대상: ${resolved}\n  캐시: ${resolvedCache}`
      );
    }
  }
}

// 메인 프로세스 싱글턴
export const repoSyncManager = new RepoSyncManager();
