import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  nodeEnv: string;
  port: number;
  sqlitePath: string;
  feishuDryRun: boolean;
  larkCliBin: string;
  llmProvider: "mock" | "openai-compatible";
  llmApiKey: string | null;
  llmBaseUrl: string | null;
  llmModel: string | null;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const sqlitePath = process.env.SQLITE_PATH ?? "./data/meeting-atlas.db";

  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3000),
    sqlitePath: path.isAbsolute(sqlitePath) ? sqlitePath : path.join(process.cwd(), sqlitePath),
    feishuDryRun: parseBoolean(process.env.FEISHU_DRY_RUN, true),
    larkCliBin: process.env.LARK_CLI_BIN || "lark",
    llmProvider: process.env.LLM_PROVIDER === "openai-compatible" ? "openai-compatible" : "mock",
    llmApiKey: process.env.LLM_API_KEY || null,
    llmBaseUrl: process.env.LLM_BASE_URL || null,
    llmModel: process.env.LLM_MODEL || null,
    ...overrides
  };
}
