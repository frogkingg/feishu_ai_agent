import { getLlmConfig, getLlmTimeoutMs, LlmRole } from "../config/env";

export function extractJsonObject(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || content).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM JSON 输出中没有对象");
  }

  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

export async function callStructuredLlm(
  messages: Array<{ role: "system" | "user"; content: string }>,
  role: LlmRole = "tool",
): Promise<Record<string, unknown> | undefined> {
  const config = getLlmConfig(role);
  if (!config) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getLlmTimeoutMs(role));

  try {
    const requestBody = {
      model: config.model,
      temperature: role === "chat" ? 0.4 : 0.1,
      response_format: { type: "json_object" },
      messages,
    };
    let response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (response.status === 400) {
      response = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ ...requestBody, response_format: undefined }),
        signal: controller.signal,
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("LLM API 返回为空");
    }

    return extractJsonObject(content);
  } finally {
    clearTimeout(timeout);
  }
}

export async function callTextLlm(
  messages: Array<{ role: "system" | "user"; content: string }>,
  role: LlmRole = "chat",
) {
  const config = getLlmConfig(role);
  if (!config) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getLlmTimeoutMs(role));

  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.4,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim();
  } finally {
    clearTimeout(timeout);
  }
}
