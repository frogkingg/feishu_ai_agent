import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

describe("GET /health", () => {
  it("returns service status without binding a port", async () => {
    const config = loadConfig({
      sqlitePath: ":memory:",
      feishuDryRun: true,
      feishuTaskCreateDryRun: true,
      feishuCalendarCreateDryRun: true,
      feishuKnowledgeWriteDryRun: true,
      feishuCardSendDryRun: true,
      larkVerificationToken: null,
      larkEncryptKey: null,
      feishuEventCardChatId: null,
      larkCardCallbackUrlHint: null
    });
    const app = buildServer({
      config,
      repos: createRepositories(createMemoryDatabase()),
      llm: new MockLlmClient()
    });

    const response = await app.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "meeting-atlas",
      phase: "phase-6",
      dry_run: true,
      read_dry_run: true,
      card_send_dry_run: true,
      card_actions_enabled: true,
      card_callback_ready: false,
      card_callback_url_configured: false,
      feishu_webhook_ready: false,
      feishu_webhook_encrypt_key_configured: false,
      feishu_webhook_verification_token_configured: false,
      feishu_event_card_chat_configured: false,
      task_create_dry_run: true,
      calendar_create_dry_run: true,
      knowledge_write_dry_run: true,
      llm_provider: "mock"
    });
  });

  it("reports card callback readiness without exposing secrets", async () => {
    const config = loadConfig({
      sqlitePath: ":memory:",
      feishuCardActionsEnabled: true,
      larkVerificationToken: "verification-token",
      larkEncryptKey: "encrypt-key",
      feishuEventCardChatId: "oc_team_room",
      larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action"
    });
    const app = buildServer({
      config,
      repos: createRepositories(createMemoryDatabase()),
      llm: new MockLlmClient()
    });

    const response = await app.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      card_callback_ready: true,
      card_callback_url_configured: true,
      feishu_webhook_ready: true,
      feishu_webhook_encrypt_key_configured: true,
      feishu_webhook_verification_token_configured: true,
      feishu_event_card_chat_configured: true
    });
    expect(JSON.stringify(response.json())).not.toContain("verification-token");
    expect(JSON.stringify(response.json())).not.toContain("encrypt-key");
    expect(JSON.stringify(response.json())).not.toContain("meetingatlas.example.com");
  });
});
