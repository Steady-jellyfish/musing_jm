/** config/repos.json 항목 구조 */
export interface RepoConfig {
  id: string;
  /** Git URL을 읽어올 환경변수명 */
  urlEnv: string;
  /** 브랜치를 읽어올 환경변수명 */
  branchEnv: string;
  description?: string;
}

export type RepoSyncStatus = "syncing" | "synced" | "stale" | "missing";

/** /health 등에 노출할 저장소별 동기화 상태 */
export interface RepoStatus {
  id: string;
  description?: string;
  status: RepoSyncStatus;
  /** 마지막 성공 동기화 시각 (ISO 8601) */
  syncedAt?: string;
  /** 경고 메시지 (stale/missing 시) */
  warning?: string;
}
