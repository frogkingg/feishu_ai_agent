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

function createMinutesWatcherConfig(overrides: Partial<AppConfig> = {}): Partial<AppConfig> {
  return {
    feishuDryRun: true,
    feishuReadDryRun: false,
    feishuCardSendDryRun: false,
    feishuCardActionsEnabled: true,
    feishuMinutesWatcherEnabled: true,
    feishuMinutesWatcherIntervalMs: 60000,
    feishuMinutesWatcherLookbackMinutes: 60,
    feishuMinutesWatcherPageSize: 30,
    feishuEventCardChatId: "oc_minutes_watcher",
    larkVerificationToken: "verification-token",
    larkEncryptKey: "encrypt-key",
    larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action",
    ...overrides
  };
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
        url: "https://example.test/recording"
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
              minutes_url: "https://example.test/recording",
              transcript_text: "【transcript pending - dry-run mode】"
            })
          ])
        );
      },
      { timeout: 7000 }
    );
  });

  it("does not generate weak confirmations when meeting-ended transcript fetch keeps failing", async () => {
    const body = JSON.stringify({
      schema: "2.0",
      header: {
        event_id: "evt_ended_pending_transcript",
        event_type: "vc.meeting.all_meeting_ended_v1",
        create_time: "1234567890000",
        token: "verification-token",
        app_id: "cli_test",
        tenant_key: "tenant_test"
      },
      event: {
        meeting_id: "om_pending_transcript",
        topic: "妙记未就绪会议",
        host_user_id: { open_id: "ou_test" }
      }
    });
    const signatureInput = {
      timestamp: currentLarkTimestamp(),
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const runnerCalls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      runnerCalls.push(args);
      throw new Error("minutes not ready");
    };
    const { app, repos } = createApp(
      {
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

    await vi.waitFor(() => {
      expect(runnerCalls).toHaveLength(4);
      expect(repos.listMeetings()).toHaveLength(0);
      expect(repos.listConfirmationRequests()).toHaveLength(0);
      expect(repos.listCliRuns().filter((run) => run.tool === "lark.im.send_card")).toHaveLength(
        0
      );
    });
  });

  it("does not generate weak confirmations for meeting_ended alias when transcript fetch keeps failing", async () => {
    const body = JSON.stringify({
      schema: "2.0",
      header: {
        event_id: "evt_meeting_ended_pending_transcript",
        event_type: "vc.meeting.meeting_ended_v1",
        create_time: "1234567890000",
        token: "verification-token",
        app_id: "cli_test",
        tenant_key: "tenant_test"
      },
      event: {
        meeting_id: "om_alias_pending_transcript",
        topic: "别名妙记未就绪会议",
        host_user_id: { open_id: "ou_test" }
      }
    });
    const signatureInput = {
      timestamp: currentLarkTimestamp(),
      nonce: "nonce-test",
      verificationToken: "verification-token",
      body
    };
    const runnerCalls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      runnerCalls.push(args);
      throw new Error("minutes not ready");
    };
    const { app, repos } = createApp(
      {
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

    await vi.waitFor(() => {
      expect(runnerCalls).toHaveLength(4);
      expect(repos.listMeetings()).toHaveLength(0);
      expect(repos.listConfirmationRequests()).toHaveLength(0);
      expect(repos.listCliRuns().filter((run) => run.tool === "lark.im.send_card")).toHaveLength(
        0
      );
    });
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

  it("does not treat fallback idempotency keys with different create_time as duplicates", async () => {
    const makeBody = (createTime: string) =>
      JSON.stringify({
        header: {
          event_type: "vc.meeting.recording_ready_v1",
          create_time: createTime,
          token: "verification-token"
        },
        event: {
          meeting_id: "om_fallback_key",
          topic: "同一会议不同投递",
          operator_id: { open_id: "ou_real" }
        }
      });
    const runnerCalls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      runnerCalls.push(args);
      return {
        stdout: JSON.stringify({ minutes: [{ content: "这是真实拉取到的逐字稿文本。" }] }),
        stderr: ""
      };
    };
    const { app } = createApp(
      {
        feishuDryRun: true,
        feishuReadDryRun: false,
        larkVerificationToken: "verification-token",
        larkEncryptKey: "encrypt-key"
      },
      runner
    );

    for (const createTime of ["1234567890000", "1234567891000"]) {
      const body = makeBody(createTime);
      const signatureInput = {
        timestamp: currentLarkTimestamp(),
        nonce: `nonce-${createTime}`,
        verificationToken: "verification-token",
        body
      };

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
    }

    await vi.waitFor(() => {
      expect(runnerCalls).toHaveLength(2);
    });
  });

  it("polls new minutes and sends generated confirmation cards without creating Feishu objects", async () => {
    const runnerCalls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      runnerCalls.push(args);
      if (args[0] === "minutes" && args[1] === "+search") {
        return {
          stdout: JSON.stringify({
            items: [
              {
                token: "min_watch_new",
                title: "无人机操作方案初步访谈",
                url: "https://example.feishu.cn/minutes/min_watch_new",
                owner_id: "ou_minutes_owner",
                create_time: "2026-05-07T09:00:00+08:00"
              }
            ]
          }),
          stderr: ""
        };
      }
      if (args[0] === "vc" && args[1] === "+notes") {
        return {
          stdout: JSON.stringify({ minutes: [{ content: "这是真实拉取到的逐字稿文本。" }] }),
          stderr: ""
        };
      }
      if (args[0] === "im" && args.includes("+messages-send")) {
        return {
          stdout: JSON.stringify({ data: { message_id: `om_watch_${runnerCalls.length}` } }),
          stderr: ""
        };
      }
      throw new Error(`unexpected lark-cli args: ${args.join(" ")}`);
    };
    const { repos } = createApp(createMinutesWatcherConfig(), runner);

    await vi.waitFor(
      () => {
        expect(repos.listMeetings()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              external_meeting_id: "minute:min_watch_new",
              title: "无人机操作方案初步访谈",
              organizer: "ou_minutes_owner",
              minutes_url: "https://example.feishu.cn/minutes/min_watch_new",
              transcript_text: expect.stringContaining("这是真实拉取到的逐字稿文本。")
            })
          ])
        );
        expect(repos.listConfirmationRequests().length).toBeGreaterThan(0);
        expect(
          repos.listCliRuns().filter((run) => run.tool === "lark.im.send_card").length
        ).toBeGreaterThan(0);
      },
      { timeout: 7000 }
    );
    expect(repos.listCliRuns().some((run) => run.tool === "lark.task.create")).toBe(false);
    expect(repos.listCliRuns().some((run) => run.tool === "lark.calendar.create")).toBe(false);
    expect(repos.listCliRuns().some((run) => run.tool.startsWith("lark.wiki"))).toBe(false);
    expect(repos.listCliRuns().some((run) => run.tool.startsWith("lark.doc"))).toBe(false);
  });

  it("skips minutes watcher tokens that are already processed", async () => {
    const runnerCalls: string[][] = [];
    const repos = createRepositories(createMemoryDatabase());
    repos.registerWebhookEvent({
      id: "webhook_event_processed",
      event_id: "minutes_watcher:min_watch_processed",
      event_type: "minutes_watcher",
      external_ref: "min_watch_processed"
    });
    repos.updateWebhookEventStatus({
      event_id: "minutes_watcher:min_watch_processed",
      status: "processed",
      error: null
    });
    const runner: LarkCliRunner = async (_bin, args) => {
      runnerCalls.push(args);
      if (args[0] === "minutes" && args[1] === "+search") {
        return {
          stdout: JSON.stringify({
            items: [{ token: "min_watch_processed", title: "已处理妙记" }]
          }),
          stderr: ""
        };
      }
      throw new Error(`unexpected lark-cli args: ${args.join(" ")}`);
    };
    buildServer({
      config: loadConfig({
        sqlitePath: ":memory:",
        larkVerificationToken: null,
        ...createMinutesWatcherConfig()
      }),
      repos,
      llm: new MockLlmClient(),
      larkCliRunner: runner
    });

    await vi.waitFor(() => {
      expect(runnerCalls.filter((args) => args[0] === "minutes")).toHaveLength(1);
    });
    expect(runnerCalls.filter((args) => args[0] === "vc")).toHaveLength(0);
    expect(repos.listMeetings()).toHaveLength(0);
    expect(repos.listConfirmationRequests()).toHaveLength(0);
    expect(repos.listCliRuns().filter((run) => run.tool === "lark.im.send_card")).toHaveLength(0);
  });

  it("retries failed minutes watcher tokens and can process them successfully", async () => {
    const runnerCalls: string[][] = [];
    const repos = createRepositories(createMemoryDatabase());
    repos.registerWebhookEvent({
      id: "webhook_event_failed",
      event_id: "minutes_watcher:min_watch_retry",
      event_type: "minutes_watcher",
      external_ref: "min_watch_retry"
    });
    repos.updateWebhookEventStatus({
      event_id: "minutes_watcher:min_watch_retry",
      status: "failed",
      error: "previous notes failure"
    });
    const runner: LarkCliRunner = async (_bin, args) => {
      runnerCalls.push(args);
      if (args[0] === "minutes" && args[1] === "+search") {
        return {
          stdout: JSON.stringify({
            items: [
              {
                token: "min_watch_retry",
                title: "无人机操作方案初步访谈",
                owner_id: "ou_retry_owner"
              }
            ]
          }),
          stderr: ""
        };
      }
      if (args[0] === "vc" && args[1] === "+notes") {
        return {
          stdout: JSON.stringify({ minutes: [{ content: "重试后拉取到妙记内容。" }] }),
          stderr: ""
        };
      }
      if (args[0] === "im" && args.includes("+messages-send")) {
        return {
          stdout: JSON.stringify({ data: { message_id: "om_retry_card" } }),
          stderr: ""
        };
      }
      throw new Error(`unexpected lark-cli args: ${args.join(" ")}`);
    };
    buildServer({
      config: loadConfig({
        sqlitePath: ":memory:",
        larkVerificationToken: null,
        ...createMinutesWatcherConfig()
      }),
      repos,
      llm: new MockLlmClient(),
      larkCliRunner: runner
    });

    await vi.waitFor(
      () => {
        expect(repos.listMeetings()).toHaveLength(1);
        expect(repos.listConfirmationRequests().length).toBeGreaterThan(0);
        expect(
          repos.listCliRuns().filter((run) => run.tool === "lark.im.send_card").length
        ).toBeGreaterThan(0);
      },
      { timeout: 7000 }
    );
    const event = repos.registerWebhookEvent({
      id: "webhook_event_retry_check",
      event_id: "minutes_watcher:min_watch_retry",
      event_type: "minutes_watcher",
      external_ref: "min_watch_retry"
    });
    expect(event.accepted).toBe(false);
    expect(event.event).toMatchObject({ status: "processed", error: null });
  });

  it("marks minutes watcher item failed when generated cards cannot be sent", async () => {
    const runner: LarkCliRunner = async (_bin, args) => {
      if (args[0] === "minutes" && args[1] === "+search") {
        return {
          stdout: JSON.stringify({
            items: [
              {
                token: "min_watch_card_fail",
                title: "无人机操作方案初步访谈",
                owner_id: "ou_card_fail_owner"
              }
            ]
          }),
          stderr: ""
        };
      }
      if (args[0] === "vc" && args[1] === "+notes") {
        return {
          stdout: JSON.stringify({ minutes: [{ content: "发卡失败场景的妙记内容。" }] }),
          stderr: ""
        };
      }
      if (args[0] === "im" && args.includes("+messages-send")) {
        throw new Error("temporary card send failure");
      }
      throw new Error(`unexpected lark-cli args: ${args.join(" ")}`);
    };
    const { repos } = createApp(createMinutesWatcherConfig(), runner);

    await vi.waitFor(() => {
      expect(repos.listCliRuns()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: "lark.im.send_card",
            status: "failed"
          })
        ])
      );
    });
    const event = repos.registerWebhookEvent({
      id: "webhook_event_card_failed_check",
      event_id: "minutes_watcher:min_watch_card_fail",
      event_type: "minutes_watcher",
      external_ref: "min_watch_card_fail"
    });
    expect(event.accepted).toBe(false);
    expect(event.event.status).toBe("failed");
    expect(event.event.error).toContain("minutes_watcher_card_send_failed");
    expect(event.event.error).toContain("failed=");
  });

  it("marks minutes watcher item failed and does not send cards when notes fetch fails", async () => {
    const runner: LarkCliRunner = async (_bin, args) => {
      if (args[0] === "minutes" && args[1] === "+search") {
        return {
          stdout: JSON.stringify({
            items: [
              {
                token: "min_watch_notes_fail",
                title: "妙记读取失败会议",
                owner_id: "ou_fail_owner"
              }
            ]
          }),
          stderr: ""
        };
      }
      if (args[0] === "vc" && args[1] === "+notes") {
        throw new Error("notes not ready");
      }
      throw new Error(`unexpected lark-cli args: ${args.join(" ")}`);
    };
    const { repos } = createApp(createMinutesWatcherConfig(), runner);

    await vi.waitFor(() => {
      expect(repos.listCliRuns()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: "lark.vc.notes",
            status: "failed"
          })
        ])
      );
    });
    const event = repos.registerWebhookEvent({
      id: "webhook_event_failed_check",
      event_id: "minutes_watcher:min_watch_notes_fail",
      event_type: "minutes_watcher",
      external_ref: "min_watch_notes_fail"
    });
    expect(event.accepted).toBe(false);
    expect(event.event).toMatchObject({
      status: "failed",
      external_ref: "min_watch_notes_fail"
    });
    expect(repos.listMeetings()).toHaveLength(0);
    expect(repos.listConfirmationRequests()).toHaveLength(0);
    expect(repos.listCliRuns().filter((run) => run.tool === "lark.im.send_card")).toHaveLength(0);
  });
});
