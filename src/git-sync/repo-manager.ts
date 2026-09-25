/**
 * Git 저장소 동기화 매니저 (메인 프로세스 전용)
 *
 * 역할:
 * - 기동 시 config/repos.json을 읽고 각 저장소를 비동기 clone/fetch (서버 기동 차단 안 함)
 * - 실패 시 설정된 간격·횟수로 재시도
 * - 최종 실패: 캐시 있으면 "stale", 없으면 "missing"
 * - 상태 전환 시(synced↔stale/missing) notify() 호출 (요청마다 중복 호출하지 않음)
 * - memberId + targetSystem → 저장소 정보 조회 제공
 *
 * Git 실행 환경:
 * - GIT_TERMINAL_PROMPT=0: 인증 프롬프트 비활성화 → 실패 시 즉시 오류 반환
 * - 인증: PC의 Git Credential Manager 사용 (코드·URL에 자격증명 미포함)
 *
 * 주기적 동기화 추가 방법:
 *   startPeriodicSync(intervalMs) 메서드 구현 후 src/index.ts에서 호출.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import type { RepoConfig, RepoLookupResult, RepoStatus, RepoSyncStatus } from "./types.js";
import { notify } from "./notify.js";

const execFileAsync = promisify(execFile);

// ── 유틸 ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GitError extends Error {
  stderr?: string;
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
      GIT_TERMINAL_PROMPT: "0", // 인증 프롬프트 비활성화 → 실패 시 즉시 종료
    },
    timeout: 60_000,
  });
}

function loadReposConfig(): RepoConfig[] {
  // 이 파일: src/git-sync/repo-manager.ts
  // repos.json: config/repos.json (프로젝트 루트)
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.resolve(thisDir, "../../config/repos.json");
  return JSON.parse(readFileSync(configPath, "utf-8")) as RepoConfig[];
}

// ── RepoSyncManager ───────────────────────────────────────

class RepoSyncManager {
  private repos: RepoConfig[] = [];
  private statuses = new Map<string, RepoStatus>();
  private readonly cacheDir: string;
  private readonly maxRetries: number;
  private readonly retryIntervalMs: number;

  constructor() {
    this.cacheDir = path.resolve(env.erpGitCacheDir);
    this.maxRetries = env.gitSync.maxRetries;
    this.retryIntervalMs = env.gitSync.retryIntervalMs;
  }

  // ── 초기화 ────────────────────────────────────────────────

  /**
   * repos.json을 읽고 각 저장소 동기화를 비동기로 시작합니다.
   * await해도 즉시 반환됩니다 (동기화는 백그라운드에서 진행).
   */
  async initialize(): Promise<void> {
    try {
      this.repos = loadReposConfig();
    } catch (err) {
      process.stderr.write(
        `WARN [git-sync] repos.json 로드 실패: ${extractGitError(err)}\n`
      );
      return;
    }

    for (const repo of this.repos) {
      const url = process.env[repo.urlEnv] ?? "";
      const branch = process.env[repo.branchEnv] ?? "";

      if (!url || !branch) {
        const missing = [!url && repo.urlEnv, !branch && repo.branchEnv]
          .filter(Boolean)
          .join(", ");
        this.updateStatus(repo.id, {
          description: repo.description,
          status: "missing",
          warning: `${missing} 환경변수가 설정되지 않았습니다.`,
        });
        process.stderr.write(`WARN [git-sync] ${repo.id}: 건너뜀 (${missing} 없음)\n`);
        continue;
      }

      // 동기화 시작 (fire-and-forget, 서버 기동 차단 안 함)
      this.updateStatus(repo.id, { description: repo.description, status: "syncing" });

      this.syncWithRetry(repo.id).catch((err) => {
        process.stderr.write(
          `WARN [git-sync] ${repo.id}: 예상치 못한 오류 — ${extractGitError(err)}\n`
        );
      });
    }
  }

  // ── 동기화 로직 ───────────────────────────────────────────

  /**
   * 저장소를 동기화합니다. 실패 시 설정된 횟수만큼 재시도합니다.
   * 최종 실패: 캐시 있으면 "stale", 없으면 "missing".
   */
  async syncWithRetry(id: string): Promise<void> {
    const localPath = path.resolve(this.cacheDir, id);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const succeeded = await this.doSyncOnce(id);

      if (succeeded) {
        this.updateStatus(id, {
          status: "synced",
          syncedAt: new Date().toISOString(),
          warning: undefined,
        });
        return;
      }

      if (attempt < this.maxRetries) {
        process.stderr.write(
          `WARN [git-sync] ${id}: 재시도 ${attempt + 1}/${this.maxRetries}` +
            ` (${this.retryIntervalMs}ms 후)\n`
        );
        await sleep(this.retryIntervalMs);
      }
    }

    // 모든 재시도 소진 — 캐시 존재 여부로 상태 결정
    const hasCache = existsSync(localPath);
    this.updateStatus(id, {
      status: hasCache ? "stale" : "missing",
      warning: hasCache
        ? `동기화 실패 ${this.maxRetries + 1}회 — 기존 캐시 사용 중`
        : `동기화 실패 ${this.maxRetries + 1}회 — 캐시 없음 (GIT_UNAVAILABLE)`,
    });
  }

  /**
   * 동기화 한 번을 시도합니다. 상태는 변경하지 않습니다.
   * @returns 성공 여부
   */
  private async doSyncOnce(id: string): Promise<boolean> {
    const repo = this.repos.find((r) => r.id === id)!;
    const url = process.env[repo.urlEnv] ?? "";
    const branch = process.env[repo.branchEnv] ?? "";
    const localPath = path.resolve(this.cacheDir, id);

    this.assertUnderCacheDir(localPath);

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }

    try {
      if (!existsSync(localPath)) {
        process.stderr.write(
          `INFO [git-sync] ${id}: git clone 시작 (branch: ${branch})\n`
        );
        await runGit(["clone", "--depth", "1", "--branch", branch, url, localPath]);
        process.stderr.write(`INFO [git-sync] ${id}: clone 완료\n`);
      } else {
        process.stderr.write(`INFO [git-sync] ${id}: git fetch 시작\n`);
        await runGit(["fetch", "origin"], localPath);
        await runGit(["reset", "--hard", `origin/${branch}`], localPath);
        process.stderr.write(`INFO [git-sync] ${id}: 최신화 완료 (origin/${branch})\n`);
      }
      return true;
    } catch (err) {
      process.stderr.write(
        `WARN [git-sync] ${id}: 동기화 시도 실패 — ${extractGitError(err)}\n`
      );
      return false;
    }
  }

  /**
   * 모든 저장소를 동기화합니다 (주기적 동기화·수동 트리거용).
   * 개별 실패는 내부에서 처리하므로 전체 실패로 이어지지 않습니다.
   */
  async syncAll(): Promise<void> {
    await Promise.allSettled(
      this.repos
        .filter((r) => (process.env[r.urlEnv] ?? "") && (process.env[r.branchEnv] ?? ""))
        .map((r) => this.syncWithRetry(r.id))
    );
  }

  /**
   * 주기적 동기화 (미구현 — 나중에 활성화)
   *
   * 사용 예시 (src/index.ts에서):
   *   repoSyncManager.startPeriodicSync(60 * 60 * 1000); // 1시간마다
   */
  // startPeriodicSync(intervalMs: number): NodeJS.Timeout {
  //   return setInterval(() => {
  //     this.syncAll().catch((err) =>
  //       process.stderr.write(`WARN [git-sync] 주기 동기화 오류: ${err.message}\n`)
  //     );
  //   }, intervalMs);
  // }

  // ── 조회 ──────────────────────────────────────────────────

  /**
   * memberId + targetSystem 조합으로 저장소 정보를 반환합니다.
   * 매칭되는 저장소가 없으면 null을 반환합니다.
   */
  getRepoForRequest(memberId: string, system: string): RepoLookupResult | null {
    const config = this.repos.find(
      (r) => r.memberId === memberId && r.system === system
    );
    if (!config) return null;

    const status = this.statuses.get(config.id) ?? {
      id: config.id,
      description: config.description,
      status: "missing" as RepoSyncStatus,
      warning: "상태 정보를 찾을 수 없습니다.",
    };

    const localPath = path.resolve(this.cacheDir, config.id);
    const hasCache = existsSync(localPath);

    return { config, status, localPath, hasCache };
  }

  /** /health에 노출할 저장소별 동기화 상태 목록 */
  getStatuses(): RepoStatus[] {
    return [...this.statuses.values()];
  }

  // ── 내부: 상태 업데이트 + notify 중복 방지 ────────────────

  /**
   * 저장소 상태를 업데이트하고, 상태가 실제로 바뀐 경우에만 notify()를 호출합니다.
   *
   * syncedAt 보존 규칙:
   * - "synced"가 될 때만 갱신
   * - stale/missing/syncing 상태에서는 이전 성공 시각을 그대로 유지
   */
  private updateStatus(
    id: string,
    updates: Partial<Omit<RepoStatus, "id">>
  ): void {
    const prev = this.statuses.get(id);

    // syncedAt은 synced 상태가 될 때만 업데이트
    const syncedAt =
      updates.status === "synced" ? updates.syncedAt : prev?.syncedAt;

    const mergedStatus = updates.status ?? prev?.status;
    if (!mergedStatus) return; // status 없으면 업데이트 불가

    const next: RepoStatus = {
      ...prev,
      id,
      ...updates,
      status: mergedStatus,
      syncedAt,
    };

    this.statuses.set(id, next);

    // 상태가 바뀐 경우에만 notify (중복 방지)
    // prevStatus가 undefined이면 최초 기동이므로 notify하지 않음 (로그로 충분)
    const prevStatus = prev?.status;
    if (prevStatus === undefined || prevStatus === next.status) return;

    if (next.status === "stale" || next.status === "missing") {
      void notify("sync_failed", {
        repoId: id,
        from: prevStatus,
        to: next.status,
        warning: next.warning,
      });
    } else if (
      next.status === "synced" &&
      (prevStatus === "stale" || prevStatus === "missing")
    ) {
      void notify("sync_recovered", { repoId: id, from: prevStatus });
    }
  }

  // ── 보안: cacheDir 하위 경로 검증 ─────────────────────────

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
