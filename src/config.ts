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
  llmTimeoutMs: number;
  llmTemperature: number;
  llmMaxTokens: number;
  llmDebugRaw: boolean;
}

type LlmProvider = AppConfig["llmProvider"];

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseLlmProvider(value: string | undefined): LlmProvider {
  return value === "openai-compatible" ? "openai-compatible" : "mock";
}

function validateConfig(config: AppConfig): AppConfig {
  if (config.llmProvider !== "openai-compatible") {
    return config;
  }

  const missing = [
    ["LLM_BASE_URL", config.llmBaseUrl],
    ["LLM_API_KEY", config.llmApiKey],
    ["LLM_MODEL", config.llmModel]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `LLM_PROVIDER=openai-compatible requires LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL. Missing: ${missing.join(", ")}`
    );
  }

  return config;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const sqlitePath = process.env.SQLITE_PATH ?? "./data/meeting-atlas.db";

  const config: AppConfig = {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3000),
    sqlitePath: path.isAbsolute(sqlitePath) ? sqlitePath : path.join(process.cwd(), sqlitePath),
    feishuDryRun: parseBoolean(process.env.FEISHU_DRY_RUN, true),
    larkCliBin: process.env.LARK_CLI_BIN || "lark-cli",
    llmProvider: parseLlmProvider(process.env.LLM_PROVIDER),
    llmApiKey: process.env.LLM_API_KEY || null,
    llmBaseUrl: process.env.LLM_BASE_URL || null,
    llmModel: process.env.LLM_MODEL || null,
    llmTimeoutMs: parseNumber(process.env.LLM_TIMEOUT_MS, 60000),
    llmTemperature: parseNumber(process.env.LLM_TEMPERATURE, 0),
    llmMaxTokens: parseNumber(process.env.LLM_MAX_TOKENS, 4096),
    llmDebugRaw: parseBoolean(process.env.LLM_DEBUG_RAW, false),
    ...overrides
  };

  return validateConfig(config);
}
