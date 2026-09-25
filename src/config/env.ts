import "dotenv/config";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",

  port: Number(process.env.PORT ?? 3000),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
  claudeMaxToolLoops: Number(process.env.CLAUDE_MAX_TOOL_LOOPS ?? 10),
  claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 60000),

  useMockContext: process.env.USE_MOCK_CONTEXT === "true",

  erpGitCacheDir: process.env.ERP_GIT_CACHE_DIR ?? "./.cache/repos",

  gitSync: {
    retryIntervalMs: Number(process.env.GIT_SYNC_RETRY_INTERVAL_MS ?? 300_000), // 기본 5분
    maxRetries: Number(process.env.GIT_SYNC_MAX_RETRIES ?? 3),
  },

  erpDb: {
    host: process.env.ERP_DB_HOST ?? "localhost",
    port: Number(process.env.ERP_DB_PORT ?? 3306),
    name: process.env.ERP_DB_NAME ?? "",
    user: process.env.ERP_DB_USER ?? "",
    password: process.env.ERP_DB_PASSWORD ?? "",
    queryTimeoutMs: Number(process.env.ERP_DB_QUERY_TIMEOUT_MS ?? 30000),
  },

  memberDb: {
    host: process.env.MEMBER_DB_HOST ?? "localhost",
    port: Number(process.env.MEMBER_DB_PORT ?? 5432),
    name: process.env.MEMBER_DB_NAME ?? "member_db",
    user: process.env.MEMBER_DB_USER ?? "",
    password: process.env.MEMBER_DB_PASSWORD ?? "",
  },

  knowledgeBase: {
    host: process.env.KB_DB_HOST ?? "localhost",
    port: Number(process.env.KB_DB_PORT ?? 5432),
    name: process.env.KB_DB_NAME ?? "knowledge_base",
    user: process.env.KB_DB_USER ?? "",
    password: process.env.KB_DB_PASSWORD ?? "",
  },

  history: {
    host: process.env.HISTORY_DB_HOST ?? "localhost",
    port: Number(process.env.HISTORY_DB_PORT ?? 5432),
    name: process.env.HISTORY_DB_NAME ?? "history_db",
    user: process.env.HISTORY_DB_USER ?? "",
    password: process.env.HISTORY_DB_PASSWORD ?? "",
  },
} as const;
