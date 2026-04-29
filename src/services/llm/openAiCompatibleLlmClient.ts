import { AppConfig } from "../../config";
import { GenerateJsonInput, LlmClient } from "./llmClient";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
}

type FetchLike = typeof fetch;
type ChatMessage = {
  role: "system" | "user";
  content: string;
};

const JSON_ONLY_INSTRUCTION = "你必须只输出 JSON，不要输出 Markdown，不要输出解释。";

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function redactForDebug(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

function tryParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function extractFencedJson(content: string): string | null {
  const trimmed = content.trim();
  const fenced =
    trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i) ??
    trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced?.[1]?.trim() ?? null;
}

function balancedJsonCandidate(content: string, start: number): string | null {
  const opener = content[start];
  const closer = opener === "{" ? "}" : "]";
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (char !== expected) {
        return null;
      }
      if (stack.length === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return null;
}

function extractEmbeddedJson(content: string): string | null {
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "{" && content[index] !== "[") {
      continue;
    }
    const candidate = balancedJsonCandidate(content, index);
    if (candidate && tryParseJson(candidate) !== null) {
      return candidate;
    }
  }

  return null;
}

function parseModelJson<T>(content: string): T {
  const trimmed = content.trim();
  const direct = tryParseJson<T>(trimmed);
  if (direct !== null) {
    return direct;
  }

  const fenced = extractFencedJson(trimmed);
  if (fenced) {
    const parsed = tryParseJson<T>(fenced);
    if (parsed !== null) {
      return parsed;
    }
  }

  const embedded = extractEmbeddedJson(trimmed);
  if (embedded) {
    const parsed = tryParseJson<T>(embedded);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new Error("LLM response content was not valid JSON");
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly debugRaw: boolean;
  private readonly fetchFn: FetchLike;

  constructor(config: AppConfig, fetchFn: FetchLike = fetch) {
    if (!config.llmBaseUrl) {
      throw new Error("LLM_BASE_URL is required when LLM_PROVIDER=openai-compatible");
    }
    if (!config.llmApiKey) {
      throw new Error("LLM_API_KEY is required when LLM_PROVIDER=openai-compatible");
    }
    if (!config.llmModel) {
      throw new Error("LLM_MODEL is required when LLM_PROVIDER=openai-compatible");
    }

    this.url = chatCompletionsUrl(config.llmBaseUrl);
    this.apiKey = config.llmApiKey;
    this.model = config.llmModel;
    this.timeoutMs = config.llmTimeoutMs;
    this.temperature = config.llmTemperature;
    this.maxTokens = config.llmMaxTokens;
    this.debugRaw = config.llmDebugRaw;
    this.fetchFn = fetchFn;
  }

  private async complete(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          messages
        }),
        signal: controller.signal
      });

      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`LLM request failed with ${response.status}: ${rawText.slice(0, 500)}`);
      }

      const payload = JSON.parse(rawText) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error(payload.error?.message ?? "LLM response did not include message content");
      }
      return content;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`LLM request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    const systemPrompt = `${input.systemPrompt}\n\n${JSON_ONLY_INSTRUCTION}`;
    const content = await this.complete([
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: input.userPrompt
      }
    ]);

    try {
      return parseModelJson<T>(content);
    } catch (firstError) {
      if (this.debugRaw) {
        console.error(`LLM raw content after parse failure: ${redactForDebug(content)}`);
      }

      const repairContent = await this.complete([
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: [
            `下面是模型为 ${input.schemaName} 输出的内容，但它不是合法 JSON。`,
            "请修正为合法 JSON，并且只返回修正后的 JSON。",
            "原始输出：",
            content
          ].join("\n")
        }
      ]);

      try {
        return parseModelJson<T>(repairContent);
      } catch (repairError) {
        if (this.debugRaw) {
          console.error(
            `LLM repair raw content after parse failure: ${redactForDebug(repairContent)}`
          );
        }
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        const repairMessage =
          repairError instanceof Error ? repairError.message : String(repairError);
        throw new Error(
          `LLM JSON parse failed after repair retry: ${repairMessage}; first error: ${firstMessage}`
        );
      }
    }
  }
}
