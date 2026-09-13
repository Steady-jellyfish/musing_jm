import "dotenv/config";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",

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
