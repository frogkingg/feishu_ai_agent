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

  it("keeps card sending dry-run by default and lets it be explicitly disabled", () => {
    expect(loadConfig({ feishuDryRun: true }).feishuCardSendDryRun).toBe(true);
    expect(loadConfig({ feishuDryRun: false }).feishuCardSendDryRun).toBe(true);
    expect(loadConfig({ feishuDryRun: true, feishuCardSendDryRun: false })).toMatchObject({
      feishuDryRun: true,
      feishuCardSendDryRun: false
    });
    expect(loadConfig({ feishuDryRun: false, feishuCardSendDryRun: true })).toMatchObject({
      feishuDryRun: false,
      feishuCardSendDryRun: true
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
