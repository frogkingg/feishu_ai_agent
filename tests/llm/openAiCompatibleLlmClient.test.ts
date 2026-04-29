import { loadConfig } from "../../src/config";
import { createLlmClient } from "../../src/services/llm/createLlmClient";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { OpenAiCompatibleLlmClient } from "../../src/services/llm/openAiCompatibleLlmClient";

function createClientWithResponses(contents: string[], baseUrl = "https://llm.example.com/v1") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const content = contents.shift() ?? "{}";
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content
            }
          }
        ]
      }),
      { status: 200 }
    );
  };
  const client = new OpenAiCompatibleLlmClient(
    loadConfig({
      llmProvider: "openai-compatible",
      llmBaseUrl: baseUrl,
      llmApiKey: "test-key",
      llmModel: "test-model",
      llmTimeoutMs: 5000,
      llmTemperature: 0.2,
      llmMaxTokens: 1234
    }),
    fetchMock
  );

  return { client, calls };
}

async function generateTestJson(client: OpenAiCompatibleLlmClient) {
  return client.generateJson<{ ok: boolean; items?: string[] }>({
    systemPrompt: "system",
    userPrompt: "user",
    schemaName: "TestSchema"
  });
}

describe("LLM client selection", () => {
  it("uses MockLlmClient by default", () => {
    const client = createLlmClient(loadConfig({ llmProvider: "mock" }));
    expect(client).toBeInstanceOf(MockLlmClient);
  });

  it("uses OpenAiCompatibleLlmClient when configured", () => {
    const client = createLlmClient(
      loadConfig({
        llmProvider: "openai-compatible",
        llmBaseUrl: "https://llm.example.com/v1",
        llmApiKey: "test-key",
        llmModel: "test-model"
      })
    );
    expect(client).toBeInstanceOf(OpenAiCompatibleLlmClient);
  });

  it("throws a clear error when OpenAI-compatible config is missing credentials", () => {
    const config = {
      ...loadConfig({ llmProvider: "mock" }),
      llmProvider: "openai-compatible" as const,
      llmBaseUrl: null,
      llmApiKey: null,
      llmModel: null
    };

    expect(() => createLlmClient(config)).toThrow("LLM_BASE_URL");
  });
});

describe("OpenAiCompatibleLlmClient", () => {
  it("posts to chat completions and parses normal JSON content", async () => {
    const { client, calls } = createClientWithResponses(['{"ok":true,"items":["a"]}']);

    const result = await generateTestJson(client);

    expect(result).toEqual({ ok: true, items: ["a"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://llm.example.com/v1/chat/completions");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer test-key"
    });
    const body = JSON.parse(String(calls[0].init.body)) as {
      model: string;
      temperature: number;
      max_tokens: number;
      response_format?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body).toMatchObject({
      model: "test-model",
      temperature: 0.2,
      max_tokens: 1234
    });
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("你必须只输出 JSON，不要输出 Markdown，不要输出解释。")
    });
    expect(body.messages[1]).toMatchObject({
      role: "user",
      content: "user"
    });
  });

  it("does not duplicate chat completions when base URL already includes it", async () => {
    const { client, calls } = createClientWithResponses(['{"ok":true}'], "https://llm.example.com/v1/chat/completions/");

    await generateTestJson(client);

    expect(calls[0].url).toBe("https://llm.example.com/v1/chat/completions");
  });

  it("parses JSON fenced in a Markdown code block", async () => {
    const { client } = createClientWithResponses(['```json\n{"ok":true,"items":["a"]}\n```']);

    await expect(generateTestJson(client)).resolves.toEqual({ ok: true, items: ["a"] });
  });

  it("extracts the first embedded JSON object from surrounding text", async () => {
    const { client } = createClientWithResponses(['前面解释 {"ok":true,"items":["a"]} 后面补充']);

    await expect(generateTestJson(client)).resolves.toEqual({ ok: true, items: ["a"] });
  });

  it("retries once with a repair prompt when JSON parsing fails", async () => {
    const { client, calls } = createClientWithResponses(["not json", '{"ok":true}']);

    await expect(generateTestJson(client)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    const repairBody = JSON.parse(String(calls[1].init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(repairBody.messages[1].content).toContain("原始输出");
    expect(repairBody.messages[1].content).toContain("只返回修正后的 JSON");
    expect(repairBody.messages[1].content).toContain("not json");
  });

  it("throws a clear parse error after one failed repair retry", async () => {
    const { client, calls } = createClientWithResponses(["not json", "still not json"]);

    await expect(generateTestJson(client)).rejects.toThrow("LLM JSON parse failed after repair retry");
    expect(calls).toHaveLength(2);
  });

  it("requires OpenAI-compatible credentials", () => {
    expect(
      () =>
        new OpenAiCompatibleLlmClient(
          loadConfig({
            llmProvider: "openai-compatible",
            llmBaseUrl: null,
            llmApiKey: "test-key",
            llmModel: "test-model"
          })
        )
    ).toThrow("LLM_BASE_URL");
  });
});
