import { createHash } from "node:crypto";
import { AppConfig } from "../../src/config";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories, Repositories } from "../../src/services/store/repositories";
import { type LarkCliRunner } from "../../src/tools/larkCli";

function sign(input: {
  timestamp: string;
  nonce: string;
  verificationToken: string;
  body: string;
}) {
  return createHash("sha256")
    .update(input.timestamp + input.nonce + input.verificationToken + input.body)
    .digest("hex");
}

function signWithSecret(input: { timestamp: string; nonce: string; secret: string; body: string }) {
  return createHash("sha256")
    .update(input.timestamp + input.nonce + input.secret + input.body)
    .digest("hex");
}

function currentLarkTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function createApp(
  configOverrides: Partial<AppConfig> = {},
  larkCliRunner?: LarkCliRunner
): {
  app: ReturnType<typeof buildServer>;
  repos: Repositories;
} {
  const repos = createRepositories(createMemoryDatabase());
  const app = buildServer({
    config: loadConfig({
      sqlitePath: ":memory:",
      larkVerificationToken: null,
      ...configOverrides
    }),
    repos,
    llm: new MockLlmClient(),
    larkCliRunner
  });

  return { app, repos };
}

describe("POST /webhooks/feishu/event", () => {
  it("returns the Feishu challenge value", async () => {
    const { app } = createApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      payload: { challenge: "challenge-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-token" });
  });

  it("returns the Feishu challenge value before missing-token checks in production", async () => {
    const { app } = createApp({ nodeEnv: "production", larkVerificationToken: null });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      payload: { challenge: "challenge-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-token" });
  });

  it("returns the Feishu challenge value before signature verification", async () => {
    const { app } = createApp({ larkVerificationToken: "verification-token" });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      payload: { challenge: "challenge-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-token" });
  });

  it("keeps ordinary events fail-closed without a verification token in production", async () => {
    const { app } = createApp({ nodeEnv: "production", larkVerificationToken: null });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      payload: { header: { event_type: "unknown.event" }, event: { id: "evt_001" } }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "LARK_VERIFICATION_TOKEN not configured" });
  });

  it("accepts unrecognized events", async () => {
    const { app } = createApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      payload: { header: { event_type: "unknown.event" }, event: { id: "evt_001" } }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
  });

  it("rejects invalid signatures when a verification token is configured", async () => {
    const { app } = createApp({ larkVerificationToken: "verification-token" });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": currentLarkTimestamp(),
        "x-lark-request-nonce": "nonce-test",
        "x-lark-signature": "bad-signature"
      },
      payload: JSON.stringify({ header: { event_type: "unknown.event" } })
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects signed events with stale timestamps", async () => {
    const body = JSON.stringify({
      header: {
        event_type: "unknown.event",
        token: "verification-token"
      },
      event: { id: "evt_replayed" }
    });
    const signatureInput = {
      timestamp: (Math.floor(Date.now() / 1000) - 301).toString(),
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const { app } = createApp({ larkVerificationToken: "verification-token" });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": signatureInput.timestamp,
        "x-lark-request-nonce": signatureInput.nonce,
        "x-lark-signature": sign(signatureInput)
      },
      payload: body
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark webhook signature" });
  });

  it("rejects signed events with missing signature headers", async () => {
    const { app } = createApp({ larkVerificationToken: "verification-token" });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": currentLarkTimestamp(),
        "x-lark-request-nonce": "nonce-test"
      },
      payload: JSON.stringify({ header: { event_type: "unknown.event" } })
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark webhook signature" });
  });

  it("accepts recording_ready events and triggers the meeting workflow in the background", async () => {
    const body = JSON.stringify({
      schema: "2.0",
      header: {
        event_id: "evt_test",
        event_type: "vc.meeting.recording_ready_v1",
        create_time: "1234567890000",
        token: "verification-token",
        app_id: "cli_test",
        tenant_key: "tenant_test"
      },
      event: {
        meeting_id: "om_test",
        topic: "测试会议",
        host_user_id: { open_id: "ou_test" },
        recording: { url: "https://example.test/recording" }
      }
    });
    const signatureInput = {
      timestamp: currentLarkTimestamp(),
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const { app, repos } = createApp({
      larkVerificationToken: "verification-token",
      larkEncryptKey: "encrypt-key"
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": signatureInput.timestamp,
        "x-lark-request-nonce": signatureInput.nonce,
        "x-lark-signature": signWithSecret({ ...signatureInput, secret: "encrypt-key" })
      },
      payload: body
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });

    await vi.waitFor(
      () => {
        expect(repos.listMeetings()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              external_meeting_id: "om_test",
              title: "测试会议",
              organizer: "ou_test",
              transcript_text: "【transcript pending - dry-run mode】"
            })
          ])
        );
      },
      { timeout: 7000 }
    );
  });

  it("auto-sends generated cards after recording_ready when card sending is enabled", async () => {
    const body = JSON.stringify({
      header: {
        event_type: "vc.meeting.recording_ready_v1",
        token: "verification-token"
      },
      event: {
        meeting_id: "om_card_send",
        topic: "无人机操作方案初步访谈",
        operator_id: { open_id: "ou_card_owner" }
      }
    });
    const signatureInput = {
      timestamp: currentLarkTimestamp(),
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const sentCardArgs: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      sentCardArgs.push(args);
      return {
        stdout: JSON.stringify({
          data: {
            message_id: `om_card_${sentCardArgs.length}`
          }
        }),
        stderr: ""
      };
    };
    const { app, repos } = createApp(
      {
        feishuDryRun: true,
        feishuCardSendDryRun: false,
        feishuCardActionsEnabled: true,
        larkVerificationToken: "verification-token",
        larkEncryptKey: "encrypt-key",
        larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action"
      },
      runner
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": signatureInput.timestamp,
        "x-lark-request-nonce": signatureInput.nonce,
        "x-lark-signature": signWithSecret({ ...signatureInput, secret: "encrypt-key" })
      },
      payload: body
    });

    expect(response.statusCode).toBe(202);

    await vi.waitFor(
      () => {
        const cardRuns = repos.listCliRuns().filter((run) => run.tool === "lark.im.send_card");
        expect(cardRuns).toHaveLength(3);
        expect(
          cardRuns.every((run) => {
            const args = JSON.parse(run.args_json) as string[];
            return args.includes("--user-id") && args.includes("ou_card_owner");
          })
        ).toBe(true);
        expect(
          repos.listConfirmationRequests().every((request) => request.card_message_id !== null)
        ).toBe(true);
      },
      { timeout: 7000 }
    );
  });

  it("uses the configured event chat as the visible card destination for meeting events", async () => {
    const body = JSON.stringify({
      header: {
        event_type: "vc.meeting.recording_ready_v1",
        token: "verification-token"
      },
      event: {
        meeting: {
          meeting_id: "om_group_card_send",
          title: "无人机操作方案初步访谈"
        },
        operator_id: { open_id: "ou_card_owner" }
      }
    });
    const signatureInput = {
      timestamp: currentLarkTimestamp(),
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const runner: LarkCliRunner = async (_bin, _args) => ({
      stdout: JSON.stringify({
        data: {
          message_id: "om_group_card"
        }
      }),
      stderr: ""
    });
    const { app, repos } = createApp(
      {
        feishuDryRun: true,
        feishuCardSendDryRun: false,
        feishuCardActionsEnabled: true,
        larkVerificationToken: "verification-token",
        larkEncryptKey: "encrypt-key",
        feishuEventCardChatId: "oc_visible_meeting_room",
        larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action"
      },
      runner
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": signatureInput.timestamp,
        "x-lark-request-nonce": signatureInput.nonce,
        "x-lark-signature": signWithSecret({ ...signatureInput, secret: "encrypt-key" })
      },
      payload: body
    });

    expect(response.statusCode).toBe(202);
    await vi.waitFor(
      () => {
        const cardRuns = repos.listCliRuns().filter((run) => run.tool === "lark.im.send_card");
        expect(cardRuns.length).toBeGreaterThan(0);
        expect(
          cardRuns.every((run) => {
            const args = JSON.parse(run.args_json) as string[];
            return args.includes("--chat-id") && args.includes("oc_visible_meeting_room");
          })
        ).toBe(true);
      },
      { timeout: 7000 }
    );
  });

  it("rejects a signed Feishu event when the payload token does not match", async () => {
    const body = JSON.stringify({
      header: {
        event_type: "unknown.event",
        token: "wrong-token"
      },
      event: { id: "evt_wrong_token" }
    });
    const signatureInput = {
      timestamp: currentLarkTimestamp(),
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const { app } = createApp({
      larkVerificationToken: "verification-token",
      larkEncryptKey: "encrypt-key"
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": signatureInput.timestamp,
        "x-lark-request-nonce": signatureInput.nonce,
        "x-lark-signature": signWithSecret({ ...signatureInput, secret: "encrypt-key" })
      },
      payload: body
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark verification token" });
  });

  it("uses fetched transcript text before triggering the workflow in read-only canary mode", async () => {
    const body = JSON.stringify({
      header: {
        event_type: "vc.meeting.recording_ready_v1",
        token: "verification-token"
      },
      event: {
        meeting_id: "om_real_transcript",
        topic: "真实转写会议",
        operator_id: { open_id: "ou_real" }
      }
    });
    const signatureInput = {
      timestamp: currentLarkTimestamp(),
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const runner: LarkCliRunner = async (_bin, args) => {
      expect(args).toEqual([
        "vc",
        "+notes",
        "--meeting-ids",
        "om_real_transcript",
        "--format",
        "json"
      ]);
      return {
        stdout: JSON.stringify({ minutes: [{ content: "这是真实拉取到的逐字稿文本。" }] }),
        stderr: ""
      };
    };
    const { app, repos } = createApp(
      {
        feishuDryRun: true,
        feishuReadDryRun: false,
        larkVerificationToken: "verification-token",
        larkEncryptKey: "encrypt-key"
      },
      runner
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": signatureInput.timestamp,
        "x-lark-request-nonce": signatureInput.nonce,
        "x-lark-signature": signWithSecret({ ...signatureInput, secret: "encrypt-key" })
      },
      payload: body
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });

    await vi.waitFor(
      () => {
        expect(repos.listMeetings()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              external_meeting_id: "om_real_transcript",
              title: "真实转写会议",
              organizer: "ou_real",
              transcript_text: expect.stringContaining("这是真实拉取到的逐字稿文本。")
            })
          ])
        );
      },
      { timeout: 7000 }
    );
  });
});
