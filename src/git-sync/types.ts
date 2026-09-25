/** config/repos.json 항목 구조 */
export interface RepoConfig {
  /** 저장소 식별자 (캐시 폴더명으로도 사용) */
  id: string;
  /** 이 저장소에 접근 가능한 회원사 ID */
  memberId: string;
  /** 대상 시스템 (요청의 targetSystem과 매칭) */
  system: string;
  /** Git URL을 읽어올 환경변수명 */
  urlEnv: string;
  /** 브랜치를 읽어올 환경변수명 (값 없으면 missing 처리) */
  branchEnv: string;
  description?: string;
}

export type RepoSyncStatus = "syncing" | "synced" | "stale" | "missing";

/** /health 등에 노출할 저장소별 동기화 상태 */
export interface RepoStatus {
  id: string;
  description?: string;
  status: RepoSyncStatus;
  /**
   * 마지막 성공 동기화 시각 (ISO 8601).
   * stale 상태에서도 이전 성공 시각을 보존합니다.
   */
  syncedAt?: string;
  /** 경고 메시지 (stale/missing 시) */
  warning?: string;
}

/** getRepoForRequest() 반환 타입 */
export interface RepoLookupResult {
  config: RepoConfig;
  status: RepoStatus;
  /** 저장소 로컬 캐시 경로 */
  localPath: string;
  /**
   * 캐시 디렉토리 존재 여부.
   * syncing 중에도 이전 캐시가 있으면 정상 처리할 수 있습니다.
   */
  hasCache: boolean;
}
