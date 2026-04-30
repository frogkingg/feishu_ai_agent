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
        "x-lark-request-timestamp": "1234567890",
        "x-lark-request-nonce": "nonce-test",
        "x-lark-signature": "bad-signature"
      },
      payload: JSON.stringify({ header: { event_type: "unknown.event" } })
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts transcription updates and triggers the meeting workflow in the background", async () => {
    const body = JSON.stringify({
      schema: "2.0",
      header: {
        event_id: "evt_test",
        event_type: "vc.meeting.transcription_updated",
        create_time: "1234567890000",
        token: "verification-token",
        app_id: "cli_test",
        tenant_key: "tenant_test"
      },
      event: {
        meeting_id: "om_test",
        topic: "测试会议",
        operator_id: { open_id: "ou_test" },
        transcript_id: "transcript_test"
      }
    });
    const signatureInput = {
      timestamp: "1234567890",
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const { app, repos } = createApp({ larkVerificationToken: "verification-token" });

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

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });

    await vi.waitFor(() => {
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
    });
  });

  it("uses fetched transcript text before triggering the workflow in real mode", async () => {
    const body = JSON.stringify({
      header: {
        event_type: "vc.meeting.transcription_updated"
      },
      event: {
        meeting_id: "om_real_transcript",
        topic: "真实转写会议",
        operator_id: { open_id: "ou_real" }
      }
    });
    const signatureInput = {
      timestamp: "1234567890",
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const runner: LarkCliRunner = async (_bin, args) => {
      expect(args).toEqual(["vc", "transcript", "get", "--meeting-id", "om_real_transcript"]);
      return {
        stdout: JSON.stringify({ text: "这是真实拉取到的逐字稿文本。" }),
        stderr: ""
      };
    };
    const { app, repos } = createApp(
      {
        feishuDryRun: false,
        larkVerificationToken: "verification-token"
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
        "x-lark-signature": sign(signatureInput)
      },
      payload: body
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });

    await vi.waitFor(() => {
      expect(repos.listMeetings()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            external_meeting_id: "om_real_transcript",
            title: "真实转写会议",
            organizer: "ou_real",
            transcript_text: "这是真实拉取到的逐字稿文本。"
          })
        ])
      );
    });
  });
});
