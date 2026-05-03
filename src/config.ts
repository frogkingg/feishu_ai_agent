import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  nodeEnv: string;
  port: number;
  sqlitePath: string;
  feishuDryRun: boolean;
  feishuReadDryRun: boolean;
  feishuCardSendDryRun: boolean;
  feishuCardActionsEnabled: boolean;
  feishuTaskCreateDryRun: boolean;
  feishuCalendarCreateDryRun: boolean;
  feishuKnowledgeWriteDryRun: boolean;
  larkVerificationToken: string | null;
  larkCardCallbackUrlHint: string | null;
  larkEncryptKey: string | null;
  devApiKey: string | null;
  larkCliBin: string;
  llmProvider: "mock" | "openai-compatible";
  llmApiKey: string | null;
  llmBaseUrl: string | null;
  llmModel: string | null;
  llmTimeoutMs: number;
  llmMaxInputChars: number;
  llmTemperature: number;
  llmMaxTokens: number;
  llmDebugRaw: boolean;
}

type LlmProvider = AppConfig["llmProvider"];

export interface CardCallbackReadiness {
  ready: boolean;
  actions_enabled: boolean;
  verification_token_configured: boolean;
  callback_url_configured: boolean;
  callback_url_public: boolean;
  callback_url_path_ok: boolean;
  issues: string[];
}

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

function looksLikePublicHttpUrl(value: string | null): {
  configured: boolean;
  publicUrl: boolean;
  pathOk: boolean;
} {
  if (!value) {
    return { configured: false, publicUrl: false, pathOk: false };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { configured: true, publicUrl: false, pathOk: false };
  }

  const hostname = parsed.hostname.toLowerCase();
  const publicUrl =
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    hostname !== "::1" &&
    !hostname.endsWith(".localhost");

  return {
    configured: true,
    publicUrl,
    pathOk: parsed.pathname.endsWith("/webhooks/feishu/card-action")
  };
}

export function getCardCallbackReadiness(config: Pick<
  AppConfig,
  "feishuCardActionsEnabled" | "larkVerificationToken" | "larkCardCallbackUrlHint"
>): CardCallbackReadiness {
  const url = looksLikePublicHttpUrl(config.larkCardCallbackUrlHint);
  const verificationTokenConfigured = Boolean(config.larkVerificationToken);
  const issues: string[] = [];

  if (!config.feishuCardActionsEnabled) {
    issues.push("FEISHU_CARD_ACTIONS_ENABLED must be true for real confirmation cards");
  }
  if (!verificationTokenConfigured) {
    issues.push("LARK_VERIFICATION_TOKEN must be configured for card-action signature verification");
  }
  if (!url.configured) {
    issues.push("LARK_CARD_CALLBACK_URL_HINT must be configured");
  } else if (!url.publicUrl) {
    issues.push("LARK_CARD_CALLBACK_URL_HINT must be an http/https public URL, not localhost or 127.0.0.1");
  }
  if (url.configured && !url.pathOk) {
    issues.push("LARK_CARD_CALLBACK_URL_HINT should end with /webhooks/feishu/card-action");
  }

  return {
    ready:
      config.feishuCardActionsEnabled &&
      verificationTokenConfigured &&
      url.configured &&
      url.publicUrl &&
      url.pathOk,
    actions_enabled: config.feishuCardActionsEnabled,
    verification_token_configured: verificationTokenConfigured,
    callback_url_configured: url.configured,
    callback_url_public: url.publicUrl,
    callback_url_path_ok: url.pathOk,
    issues
  };
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
  const feishuDryRun = parseBoolean(process.env.FEISHU_DRY_RUN, true);

  const config: AppConfig = {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3000),
    sqlitePath: path.isAbsolute(sqlitePath) ? sqlitePath : path.join(process.cwd(), sqlitePath),
    feishuDryRun,
    feishuReadDryRun: parseBoolean(process.env.FEISHU_READ_DRY_RUN, feishuDryRun),
    feishuCardSendDryRun: parseBoolean(process.env.FEISHU_CARD_SEND_DRY_RUN, true),
    feishuCardActionsEnabled: parseBoolean(process.env.FEISHU_CARD_ACTIONS_ENABLED, true),
    feishuTaskCreateDryRun: parseBoolean(process.env.FEISHU_TASK_CREATE_DRY_RUN, feishuDryRun),
    feishuCalendarCreateDryRun: parseBoolean(
      process.env.FEISHU_CALENDAR_CREATE_DRY_RUN,
      feishuDryRun
    ),
    feishuKnowledgeWriteDryRun: parseBoolean(
      process.env.FEISHU_KNOWLEDGE_WRITE_DRY_RUN,
      feishuDryRun
    ),
    larkVerificationToken: process.env.LARK_VERIFICATION_TOKEN || null,
    larkCardCallbackUrlHint: process.env.LARK_CARD_CALLBACK_URL_HINT || null,
    larkEncryptKey: process.env.LARK_ENCRYPT_KEY || null,
    devApiKey: process.env.DEV_API_KEY || null,
    larkCliBin: process.env.LARK_CLI_BIN || "lark-cli",
    llmProvider: parseLlmProvider(process.env.LLM_PROVIDER),
    llmApiKey: process.env.LLM_API_KEY || null,
    llmBaseUrl: process.env.LLM_BASE_URL || null,
    llmModel: process.env.LLM_MODEL || null,
    llmTimeoutMs: parseNumber(process.env.LLM_TIMEOUT_MS, 30000),
    llmMaxInputChars: parseNumber(process.env.LLM_MAX_INPUT_CHARS, 30000),
    llmTemperature: parseNumber(process.env.LLM_TEMPERATURE, 0),
    llmMaxTokens: parseNumber(process.env.LLM_MAX_TOKENS, 4096),
    llmDebugRaw: parseBoolean(process.env.LLM_DEBUG_RAW, false),
    ...overrides
  };
  if (overrides.feishuDryRun !== undefined && overrides.feishuReadDryRun === undefined) {
    config.feishuReadDryRun = overrides.feishuDryRun;
  }
  if (overrides.feishuDryRun !== undefined && overrides.feishuTaskCreateDryRun === undefined) {
    config.feishuTaskCreateDryRun = overrides.feishuDryRun;
  }
  if (overrides.feishuDryRun !== undefined && overrides.feishuCalendarCreateDryRun === undefined) {
    config.feishuCalendarCreateDryRun = overrides.feishuDryRun;
  }
  if (overrides.feishuDryRun !== undefined && overrides.feishuKnowledgeWriteDryRun === undefined) {
    config.feishuKnowledgeWriteDryRun = overrides.feishuDryRun;
  }

  return validateConfig(config);
}
