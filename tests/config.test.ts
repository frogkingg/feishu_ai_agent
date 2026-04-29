import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("defaults to mock LLM without API credentials", () => {
    const config = loadConfig({
      llmApiKey: null,
      llmBaseUrl: null,
      llmModel: null
    });

    expect(config.llmProvider).toBe("mock");
    expect(config.llmApiKey).toBeNull();
    expect(config.llmBaseUrl).toBeNull();
    expect(config.llmModel).toBeNull();
  });

  it("parses optional LLM runtime controls", () => {
    const config = loadConfig({
      llmTimeoutMs: 12345,
      llmTemperature: 0.3,
      llmMaxTokens: 2048,
      llmDebugRaw: true
    });

    expect(config).toMatchObject({
      llmTimeoutMs: 12345,
      llmTemperature: 0.3,
      llmMaxTokens: 2048,
      llmDebugRaw: true
    });
  });

  it("lets card sending dry-run follow or override the global Feishu dry-run flag", () => {
    expect(loadConfig({ feishuDryRun: true }).feishuCardDryRun).toBe(true);
    expect(loadConfig({ feishuDryRun: false }).feishuCardDryRun).toBe(false);
    expect(loadConfig({ feishuDryRun: true, feishuCardDryRun: false })).toMatchObject({
      feishuDryRun: true,
      feishuCardDryRun: false
    });
    expect(loadConfig({ feishuDryRun: false, feishuCardDryRun: true })).toMatchObject({
      feishuDryRun: false,
      feishuCardDryRun: true
    });
  });

  it("throws a clear error when OpenAI-compatible config is incomplete", () => {
    expect(() =>
      loadConfig({
        llmProvider: "openai-compatible",
        llmBaseUrl: null,
        llmApiKey: null,
        llmModel: null
      })
    ).toThrow(
      "LLM_PROVIDER=openai-compatible requires LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL. Missing: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL"
    );
  });

  it("accepts OpenAI-compatible config when base URL, API key, and model are present", () => {
    const config = loadConfig({
      llmProvider: "openai-compatible",
      llmBaseUrl: "https://llm.example.com/v1",
      llmApiKey: "test-key",
      llmModel: "test-model"
    });

    expect(config).toMatchObject({
      llmProvider: "openai-compatible",
      llmBaseUrl: "https://llm.example.com/v1",
      llmApiKey: "test-key",
      llmModel: "test-model"
    });
  });
});
