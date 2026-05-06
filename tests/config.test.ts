import { getCardCallbackReadiness, getFeishuWebhookReadiness, loadConfig } from "../src/config";

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

  it("loads default host and allows an explicit override", () => {
    expect(loadConfig().host).toBe("127.0.0.1");
    expect(loadConfig({ host: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  it("parses optional LLM runtime controls", () => {
    const config = loadConfig({
      llmTimeoutMs: 12345,
      llmMaxInputChars: 54321,
      llmTemperature: 0.3,
      llmMaxTokens: 2048,
      llmDebugRaw: true
    });

    expect(config).toMatchObject({
      llmTimeoutMs: 12345,
      llmMaxInputChars: 54321,
      llmTemperature: 0.3,
      llmMaxTokens: 2048,
      llmDebugRaw: true
    });
  });

  it("keeps card sending dry-run by default and lets it be explicitly disabled", () => {
    expect(loadConfig().feishuCardSendDryRun).toBe(true);
    expect(loadConfig().feishuCardActionsEnabled).toBe(true);
    expect(loadConfig({ feishuDryRun: true }).feishuCardSendDryRun).toBe(true);
    expect(loadConfig({ feishuDryRun: false }).feishuCardSendDryRun).toBe(true);
    expect(
      loadConfig({
        feishuDryRun: true,
        feishuCardSendDryRun: false,
        feishuCardActionsEnabled: false
      })
    ).toMatchObject({
      feishuDryRun: true,
      feishuCardSendDryRun: false,
      feishuCardActionsEnabled: false
    });
    expect(loadConfig({ feishuDryRun: false, feishuCardSendDryRun: true })).toMatchObject({
      feishuDryRun: false,
      feishuCardSendDryRun: true
    });
  });

  it("keeps Feishu reads dry-run by default but allows read-only canary mode", () => {
    expect(loadConfig({ feishuDryRun: true })).toMatchObject({
      feishuDryRun: true,
      feishuReadDryRun: true
    });
    expect(loadConfig({ feishuDryRun: false })).toMatchObject({
      feishuDryRun: false,
      feishuReadDryRun: false
    });
    expect(loadConfig({ feishuDryRun: true, feishuReadDryRun: false })).toMatchObject({
      feishuDryRun: true,
      feishuReadDryRun: false
    });
  });

  it("keeps workflow writes dry-run by default but allows per-type canaries", () => {
    expect(loadConfig({ feishuDryRun: true })).toMatchObject({
      feishuTaskCreateDryRun: true,
      feishuCalendarCreateDryRun: true,
      feishuKnowledgeWriteDryRun: true
    });
    expect(loadConfig({ feishuDryRun: false })).toMatchObject({
      feishuTaskCreateDryRun: false,
      feishuCalendarCreateDryRun: false,
      feishuKnowledgeWriteDryRun: false
    });
    expect(
      loadConfig({
        feishuDryRun: true,
        feishuTaskCreateDryRun: false,
        feishuCalendarCreateDryRun: false,
        feishuKnowledgeWriteDryRun: false
      })
    ).toMatchObject({
      feishuDryRun: true,
      feishuTaskCreateDryRun: false,
      feishuCalendarCreateDryRun: false,
      feishuKnowledgeWriteDryRun: false
    });
  });

  it("loads optional Lark webhook credentials", () => {
    expect(
      loadConfig({
        larkVerificationToken: null,
        larkCardCallbackUrlHint: null,
        larkEncryptKey: null,
        feishuEventCardChatId: null
      })
    ).toMatchObject({
      larkVerificationToken: null,
      larkCardCallbackUrlHint: null,
      larkEncryptKey: null,
      feishuEventCardChatId: null
    });

    expect(
      loadConfig({
        larkVerificationToken: "verification-token",
        larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action",
        larkEncryptKey: "encrypt-key",
        feishuEventCardChatId: "oc_team_room"
      })
    ).toMatchObject({
      larkVerificationToken: "verification-token",
      larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action",
      larkEncryptKey: "encrypt-key",
      feishuEventCardChatId: "oc_team_room"
    });
  });

  it("reports card callback readiness without exposing token values", () => {
    expect(
      getCardCallbackReadiness(
        loadConfig({
          feishuCardActionsEnabled: true,
          larkVerificationToken: "verification-token",
          larkEncryptKey: "encrypt-key",
          larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action"
        })
      )
    ).toMatchObject({
      ready: true,
      actions_enabled: true,
      verification_token_configured: true,
      encrypt_key_configured: true,
      callback_url_configured: true,
      callback_url_public: true,
      callback_url_path_ok: true,
      issues: []
    });

    expect(
      getCardCallbackReadiness(
        loadConfig({
          feishuCardActionsEnabled: true,
          larkVerificationToken: "",
          larkEncryptKey: "",
          larkCardCallbackUrlHint: "http://localhost:3000/webhooks/feishu/card-action"
        })
      )
    ).toMatchObject({
      ready: false,
      verification_token_configured: false,
      encrypt_key_configured: false,
      callback_url_configured: true,
      callback_url_public: false,
      callback_url_path_ok: true
    });
  });

  it("reports Feishu event webhook readiness without exposing secrets", () => {
    expect(
      getFeishuWebhookReadiness(
        loadConfig({
          larkVerificationToken: "verification-token",
          larkEncryptKey: "encrypt-key",
          feishuEventCardChatId: "oc_team_room"
        })
      )
    ).toMatchObject({
      ready: true,
      verification_token_configured: true,
      encrypt_key_configured: true,
      event_card_chat_configured: true,
      issues: []
    });

    expect(
      getFeishuWebhookReadiness(
        loadConfig({
          larkVerificationToken: null,
          larkEncryptKey: null,
          feishuEventCardChatId: null
        })
      )
    ).toMatchObject({
      ready: false,
      verification_token_configured: false,
      encrypt_key_configured: false,
      event_card_chat_configured: false
    });
  });

  it("loads optional dev API key", () => {
    expect(loadConfig({ devApiKey: null }).devApiKey).toBeNull();
    expect(loadConfig({ devApiKey: "dev-secret" }).devApiKey).toBe("dev-secret");
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
