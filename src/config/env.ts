export type LlmRole = "chat" | "router" | "tool";

export function getRoleEnv(role: LlmRole, name: "API_KEY" | "API_URL" | "BASE_URL" | "MODEL") {
  const upperRole = role.toUpperCase();
  return (
    process.env[`PROJECTPILOT_${upperRole}_${name}`] ||
    process.env[`OPENAI_${upperRole}_${name}`] ||
    process.env[`LLM_${upperRole}_${name}`]
  );
}

export function getLlmTimeoutMs(role: LlmRole) {
  const upperRole = role.toUpperCase();
  const raw =
    process.env[`PROJECTPILOT_${upperRole}_TIMEOUT_MS`] ||
    process.env[`LLM_${upperRole}_TIMEOUT_MS`];
  const parsed = raw ? Number(raw) : undefined;
  if (parsed && Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return role === "router" ? 12_000 : Math.max(Number(process.env.LLM_TIMEOUT_MS || 35_000), 30_000);
}

export function getLlmConfig(role: LlmRole = "tool") {
  const apiKey = getRoleEnv(role, "API_KEY") || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  const apiUrl = getRoleEnv(role, "API_URL") || process.env.OPENAI_API_URL || process.env.LLM_API_URL;
  const baseUrl = (
    getRoleEnv(role, "BASE_URL") ||
    process.env.OPENAI_BASE_URL ||
    process.env.LLM_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");

  return {
    apiKey,
    apiUrl: apiUrl || `${baseUrl}/chat/completions`,
    model: getRoleEnv(role, "MODEL") || process.env.OPENAI_MODEL || process.env.LLM_MODEL || "gpt-4o-mini",
  };
}
