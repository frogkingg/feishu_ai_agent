import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { ConfirmationRequestRow, createRepositories } from "../../src/services/store/repositories";
import { type LarkCliRunner } from "../../src/tools/larkCli";

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function signLegacyCardAction(input: {
  timestamp: string;
  nonce: string;
  body: unknown;
  verificationToken: string;
}) {
  return createHash("sha1")
    .update(input.timestamp + input.nonce + input.verificationToken + JSON.stringify(input.body))
    .digest("hex");
}

function currentLarkTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function goTimeString(date: Date) {
  const datePart = date.toISOString().slice(0, 19).replace("T", " ");
  const nanoseconds = date.getUTCMilliseconds().toString().padStart(3, "0").padEnd(9, "0");
  return `${datePart}.${nanoseconds} +0000 UTC m=+1234.5678`;
}

function contentArg(args: string[]) {
  const contentIndex = args.indexOf("--content");
  expect(contentIndex).toBeGreaterThanOrEqual(0);
  return args[contentIndex + 1];
}

function dataArg(args: string[]) {
  const dataIndex = args.indexOf("--data");
  expect(dataIndex).toBeGreaterThanOrEqual(0);
  return args[dataIndex + 1];
}

function createDirectActionConfirmation(
  repos: ReturnType<typeof createRepositories>,
  options: { cardMessageId?: string | null } = {}
) {
  const meeting = repos.createMeeting({
    id: "mtg_direct_card_action",
    external_meeting_id: null,
    title: "客户访谈复盘",
    started_at: "2026-05-01T10:00:00+08:00",
    ended_at: "2026-05-01T11:00:00+08:00",
    organizer: "ou_owner",
    participants_json: JSON.stringify(["ou_owner"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "张三负责整理客户访谈结论。",
    summary: "会议确认访谈结论整理动作。",
    keywords_json: JSON.stringify(["客户访谈"]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 1,
    calendar_count: 0
  });
  const action = repos.createActionItem({
    id: "act_direct_card_action",
    meeting_id: meeting.id,
    kb_id: null,
    title: "整理客户访谈结论",
    description: "汇总访谈输出。",
    owner: "ou_owner",
    collaborators_json: JSON.stringify([]),
    due_date: "2026-05-03",
    priority: "P1",
    evidence: "张三负责整理客户访谈结论。",
    confidence: 0.91,
    suggested_reason: "会议明确了负责人。",
    missing_fields_json: JSON.stringify([]),
    confirmation_status: "candidate",
    feishu_task_guid: null,
    task_url: null,
    rejection_reason: null
  });

  return repos.createConfirmationRequest({
    id: "conf_direct_card_action",
    request_type: "action",
    target_id: action.id,
    recipient: "ou_owner",
    card_message_id: options.cardMessageId ?? null,
    status: "sent",
    original_payload_json: JSON.stringify({
      draft: {
        title: action.title,
        description: action.description,
        owner: action.owner,
        collaborators: [],
        due_date: action.due_date,
        priority: action.priority,
        evidence: action.evidence,
        confidence: action.confidence,
        suggested_reason: action.suggested_reason,
        missing_fields: []
      },
      meeting_reference: "客户访谈复盘（会议纪要：https://example.feishu.cn/minutes/min_direct）"
    }),
    edited_payload_json: null,
    confirmed_at: null,
    executed_at: null,
    error: null
  });
}

function createMissingOwnerActionConfirmation(
  repos: ReturnType<typeof createRepositories>,
  options: { recipient?: string | null } = {}
) {
  const meeting = repos.createMeeting({
    id: "mtg_missing_owner_card_action",
    external_meeting_id: null,
    title: "客户访谈复盘",
    started_at: "2026-05-01T10:00:00+08:00",
    ended_at: "2026-05-01T11:00:00+08:00",
    organizer: "ou_organizer",
    participants_json: JSON.stringify(["ou_organizer"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "会议中提出需要整理客户访谈结论，但没有明确负责人。",
    summary: "会议提出访谈结论整理动作。",
    keywords_json: JSON.stringify(["客户访谈"]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 1,
    calendar_count: 0
  });
  const action = repos.createActionItem({
    id: "act_missing_owner_card_action",
    meeting_id: meeting.id,
    kb_id: null,
    title: "整理客户访谈结论",
    description: "汇总访谈输出。",
    owner: null,
    collaborators_json: JSON.stringify([]),
    due_date: "2026-05-03",
    priority: "P1",
    evidence: "会议中提出需要整理客户访谈结论，但没有明确负责人。",
    confidence: 0.82,
    suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。",
    missing_fields_json: JSON.stringify(["owner"]),
    confirmation_status: "sent",
    feishu_task_guid: null,
    task_url: null,
    rejection_reason: null
  });

  return repos.createConfirmationRequest({
    id: "conf_missing_owner_card_action",
    request_type: "action",
    target_id: action.id,
    recipient: options.recipient === undefined ? "ou_organizer" : options.recipient,
    card_message_id: null,
    status: "sent",
    original_payload_json: JSON.stringify({
      draft: {
        title: action.title,
        description: action.description,
        owner: action.owner,
        collaborators: [],
        due_date: action.due_date,
        priority: action.priority,
        evidence: action.evidence,
        confidence: action.confidence,
        suggested_reason: action.suggested_reason,
        missing_fields: ["owner"]
      }
    }),
    edited_payload_json: null,
    confirmed_at: null,
    executed_at: null,
    error: null
  });
}

function createDirectCreateKbConfirmation(repos: ReturnType<typeof createRepositories>) {
  const meeting = repos.createMeeting({
    id: "mtg_create_kb_card_action",
    external_meeting_id: null,
    title: "客户访谈知识沉淀",
    started_at: "2026-05-02T10:00:00+08:00",
    ended_at: "2026-05-02T11:00:00+08:00",
    organizer: "ou_owner",
    participants_json: JSON.stringify(["ou_owner"]),
    minutes_url: "https://example.feishu.cn/minutes/min_create_kb",
    transcript_url: null,
    transcript_text: "这两次客户访谈需要沉淀成知识库。",
    summary: "会议确认客户访谈资料需要沉淀。",
    keywords_json: JSON.stringify(["客户访谈"]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "suggested",
    action_count: 0,
    calendar_count: 0
  });

  return repos.createConfirmationRequest({
    id: "conf_create_kb_card_action",
    request_type: "create_kb",
    target_id: "kb_candidate_card_action",
    recipient: "ou_owner",
    card_message_id: null,
    status: "sent",
    original_payload_json: JSON.stringify({
      topic_name: "客户访谈知识库",
      suggested_goal: "沉淀客户访谈结论。",
      candidate_meeting_ids: [meeting.id],
      meeting_ids: [meeting.id],
      meeting_summary: meeting.summary,
      score: 0.86,
      match_reasons: ["用户显式提出创建知识库"],
      topic_match: {
        current_meeting_id: meeting.id,
        matched_kb_id: null,
        matched_kb_name: null,
        score: 0.86,
        match_reasons: ["用户显式提出创建知识库"],
        suggested_action: "ask_create",
        candidate_meeting_ids: [meeting.id]
      },
      reason: "检测到相关会议，建议创建主题知识库。"
    }),
    edited_payload_json: null,
    confirmed_at: null,
    executed_at: null,
    error: null
  });
}

async function createAppWithConfirmations(larkVerificationToken: string | null = null) {
  const repos = createRepositories(createMemoryDatabase());
  const app = buildServer({
    config: loadConfig({
      feishuDryRun: true,
      larkCliBin: "definitely-not-real-lark",
      sqlitePath: ":memory:",
      larkVerificationToken
    }),
    repos,
    llm: new MockLlmClient()
  });

  await app.inject({
    method: "POST",
    url: "/dev/meetings/manual",
    payload: {
      title: "无人机操作方案初步访谈",
      participants: ["张三", "李四"],
      organizer: "张三",
      started_at: "2026-04-28T10:00:00+08:00",
      ended_at: "2026-04-28T11:00:00+08:00",
      transcript_text: readFileSync(
        join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
        "utf8"
      )
    }
  });

  const action = repos.listConfirmationRequests().find((item) => item.request_type === "action");
  const calendar = repos
    .listConfirmationRequests()
    .find((item) => item.request_type === "calendar");
  const createKb = createDirectCreateKbConfirmation(repos);

  return {
    app,
    repos,
    action: action as ConfirmationRequestRow,
    calendar: calendar as ConfirmationRequestRow,
    createKb
  };
}

function createOwnerCompletionApp() {
  const repos = createRepositories(createMemoryDatabase());
  const app = buildServer({
    config: loadConfig({
      feishuDryRun: true,
      larkVerificationToken: null,
      larkCliBin: "definitely-not-real-lark",
      sqlitePath: ":memory:"
    }),
    repos,
    llm: new MockLlmClient()
  });
  const confirmation = createMissingOwnerActionConfirmation(repos);

  return { app, repos, confirmation };
}

describe("POST /webhooks/feishu/card-action", () => {
  it("returns the Feishu challenge value before signature verification", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        sqlitePath: ":memory:",
        larkVerificationToken: "verification-token"
      }),
      repos,
      llm: new MockLlmClient()
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: { challenge: "challenge-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-token" });
  });

  it("returns the Feishu challenge value before missing-token checks in production", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        nodeEnv: "production",
        sqlitePath: ":memory:",
        larkVerificationToken: null
      }),
      repos,
      llm: new MockLlmClient()
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: { challenge: "challenge-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-token" });
  });

  it("keeps ordinary card actions fail-closed without a verification token in production", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        nodeEnv: "production",
        sqlitePath: ":memory:",
        larkVerificationToken: null
      }),
      repos,
      llm: new MockLlmClient()
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: "nonexistent",
            action: "confirm"
          }
        }
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "LARK_VERIFICATION_TOKEN not configured" });
  });

  it("accepts legacy Feishu card-action callbacks signed with 40-character sha1 signatures", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };
    const timestamp = currentLarkTimestamp();
    const nonce = "legacy-card-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      toast: {
        type: "error",
        content: "确认请求不存在"
      }
    });
  });

  it("accepts Feishu card-action callbacks with millisecond timestamps", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };
    const timestamp = Date.now().toString();
    const nonce = "legacy-card-ms-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      toast: {
        type: "error",
        content: "确认请求不存在"
      }
    });
  });

  it("accepts Feishu card-action callbacks with Go time string timestamps signed as the raw header", async () => {
    const verificationToken = "verification-token";
    const { app, action } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: action.id,
          action: "confirm"
        }
      }
    };
    const timestamp = goTimeString(new Date());
    const nonce = "legacy-card-go-time-timestamp-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已确认，处理完成"
      },
      card: expect.any(Object)
    });
  });

  it("accepts Feishu card-action callbacks with ISO timestamps signed as the raw header", async () => {
    const verificationToken = "verification-token";
    const { app, action } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: action.id,
          action: "confirm"
        }
      }
    };
    const timestamp = new Date().toISOString();
    const nonce = "legacy-card-iso-timestamp-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已确认，处理完成"
      },
      card: expect.any(Object)
    });
  });

  it("accepts Feishu card-action callbacks with comma-joined duplicate timestamp headers", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };
    const signedTimestamp = currentLarkTimestamp();
    const timestamp = `${signedTimestamp}, ${signedTimestamp}`;
    const nonce = "legacy-card-comma-timestamp-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp: signedTimestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      toast: {
        type: "error",
        content: "确认请求不存在"
      }
    });
  });

  it("accepts Feishu card-action callbacks with ts-prefixed timestamp headers", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };
    const signedTimestamp = currentLarkTimestamp();
    const nonce = "legacy-card-ts-prefixed-timestamp-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": `ts=${signedTimestamp}`,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp: signedTimestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      toast: {
        type: "error",
        content: "确认请求不存在"
      }
    });
  });

  it("accepts Feishu card-action callbacks with quoted and bracketed timestamp headers", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };

    for (const [timestampHeader, nonce] of [
      [`"${currentLarkTimestamp()}"`, "legacy-card-quoted-timestamp-nonce"],
      [`[${currentLarkTimestamp()}]`, "legacy-card-bracketed-timestamp-nonce"]
    ]) {
      const signedTimestamp = timestampHeader.replace(/\D/g, "");
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/feishu/card-action",
        headers: {
          "x-lark-request-timestamp": timestampHeader,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": signLegacyCardAction({
            timestamp: signedTimestamp,
            nonce,
            body: payload,
            verificationToken
          })
        },
        payload
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        toast: {
          type: "error",
          content: "确认请求不存在"
        }
      });
    }
  });

  it("accepts Feishu card-action callbacks with microsecond and nanosecond timestamps", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };

    for (const [timestamp, nonce] of [
      [(Date.now() * 1000).toString(), "legacy-card-microsecond-timestamp-nonce"],
      [(Date.now() * 1_000_000).toString(), "legacy-card-nanosecond-timestamp-nonce"]
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/feishu/card-action",
        headers: {
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": signLegacyCardAction({
            timestamp,
            nonce,
            body: payload,
            verificationToken
          })
        },
        payload
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        toast: {
          type: "error",
          content: "确认请求不存在"
        }
      });
    }
  });

  it("rejects wrapped Feishu card-action timestamps when no fresh epoch-like token is present", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };
    const signedTimestamp = currentLarkTimestamp();
    const timestamp = "ts=12345; version=2; port=443";
    const nonce = "legacy-card-no-epoch-like-timestamp-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp: signedTimestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark webhook signature" });
  });

  it("rejects fresh ISO Feishu card-action timestamps when the signature was not made with the raw header", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };
    const signedTimestamp = currentLarkTimestamp();
    const timestamp = new Date().toISOString();
    const nonce = "legacy-card-iso-ish-timestamp-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp: signedTimestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark webhook signature" });
  });

  it("rejects stale Go time string Feishu card-action timestamps", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };
    const timestamp = goTimeString(new Date(Date.now() - 301_000));
    const nonce = "legacy-card-stale-go-time-timestamp-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark webhook signature" });
  });

  it("rejects comma-joined Feishu card-action timestamps when all candidates are stale", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };
    const signedTimestamp = (Math.floor(Date.now() / 1000) - 301).toString();
    const timestamp = `${signedTimestamp}, ${signedTimestamp}`;
    const nonce = "legacy-card-stale-comma-timestamp-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp: signedTimestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark webhook signature" });
  });

  it("rejects invalid legacy Feishu card-action signatures", async () => {
    const { app } = await createAppWithConfirmations("verification-token");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": currentLarkTimestamp(),
        "x-lark-request-nonce": "legacy-card-nonce",
        "x-lark-signature": "bad-signature"
      },
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: "nonexistent",
            action: "confirm"
          }
        }
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark webhook signature" });
  });

  it("rejects legacy Feishu card-action callbacks with stale timestamps", async () => {
    const verificationToken = "verification-token";
    const { app } = await createAppWithConfirmations(verificationToken);
    const payload = {
      open_id: "ou_test",
      action: {
        value: {
          confirmation_id: "nonexistent",
          action: "confirm"
        }
      }
    };
    const timestamp = (Math.floor(Date.now() / 1000) - 301).toString();
    const nonce = "legacy-card-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark webhook signature" });
  });

  it("rejects legacy Feishu card-action callbacks with missing signature headers", async () => {
    const { app } = await createAppWithConfirmations("verification-token");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": currentLarkTimestamp(),
        "x-lark-request-nonce": "legacy-card-nonce"
      },
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: "nonexistent",
            action: "confirm"
          }
        }
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Lark webhook signature" });
  });

  it("returns an error toast when the confirmation does not exist", async () => {
    const { app } = await createAppWithConfirmations();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: "nonexistent",
            action: "confirm"
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      toast: {
        type: "error",
        content: "确认请求不存在"
      }
    });
  });

  it("confirms and rejects requests from Feishu card callbacks", async () => {
    const { app, repos, action, calendar } = await createAppWithConfirmations();

    const confirmResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: action.id,
            action: "confirm"
          }
        }
      }
    });
    expect(confirmResponse.statusCode).toBe(200);
    expect(confirmResponse.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已确认，处理完成"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(confirmResponse.json().card)).toContain("已添加待办");
    expect(repos.getConfirmationRequest(action.id)?.status).toBe("executed");

    const rejectResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: calendar.id,
            action: "reject"
          }
        }
      }
    });
    expect(rejectResponse.statusCode).toBe(200);
    expect(rejectResponse.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已拒绝"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(rejectResponse.json().card)).toContain("已不添加");
    expect(repos.getConfirmationRequest(calendar.id)?.status).toBe("rejected");
  });

  it("returns an error toast for unsupported card actions", async () => {
    const { app, action } = await createAppWithConfirmations();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        event: {
          action: {
            value: {
              confirmation_id: action.id,
              action_key: "unexpected_action"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      toast: {
        type: "error",
        content: "暂不支持此操作"
      }
    });
  });

  it("parses real Feishu action payloads and applies user edited fields", async () => {
    const { app, repos, action } = await createAppWithConfirmations();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        schema: "2.0",
        header: {
          event_type: "card.action.trigger"
        },
        event: {
          operator: {
            user_id: {
              open_id: "ou_editor"
            }
          },
          context: {
            open_message_id: "om_card_message",
            open_chat_id: "oc_test_chat"
          },
          action: {
            tag: "button",
            value: {
              confirmation_id: action.id,
              action_key: "confirm_with_edits",
              edited_payload: "$editable_fields"
            },
            form_value: {
              owner: "王五",
              due_date: "2026-05-02",
              priority: {
                value: "P0"
              }
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已确认，处理完成"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(response.json().card)).toContain("已添加待办");

    const updatedAction = repos.getActionItem(action.target_id);
    expect(updatedAction).toMatchObject({
      owner: "王五",
      due_date: "2026-05-02",
      priority: "P0",
      confirmation_status: "created"
    });
    const updatedConfirmation = repos.getConfirmationRequest(action.id);
    expect(updatedConfirmation?.status).toBe("executed");
    expect(JSON.parse(updatedConfirmation?.edited_payload_json ?? "{}")).toMatchObject({
      owner: "王五",
      due_date: "2026-05-02",
      priority: "P0"
    });
  });

  it("adds missing-owner actions to the card recipient's personal todo", async () => {
    const { app, repos, confirmation } = createOwnerCompletionApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        event: {
          action: {
            value: {
              confirmation_id: confirmation.id,
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已确认，处理完成"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(response.json().card)).toContain("已添加待办");
    expect(JSON.stringify(response.json().card)).not.toContain("补全负责人");
    expect(JSON.stringify(response.json().card)).not.toContain('"tag":"select_person"');

    expect(repos.getActionItem(confirmation.target_id)).toMatchObject({
      owner: "ou_organizer",
      confirmation_status: "created",
      feishu_task_guid: `dry_task_${confirmation.target_id}`,
      task_url: `mock://feishu/task/${confirmation.target_id}`
    });
    expect(repos.getConfirmationRequest(confirmation.id)).toMatchObject({
      status: "executed",
      error: null
    });
    const taskRuns = repos.listCliRuns().filter((run) => run.tool === "lark.task.create");
    expect(taskRuns).toHaveLength(1);
    expect(JSON.parse(taskRuns[0].args_json) as string[]).toEqual(
      expect.arrayContaining(["--assignee", "ou_organizer"])
    );
  });

  it("uses the Feishu card callback user when a missing-owner card has no recipient", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        larkVerificationToken: null,
        larkCliBin: "definitely-not-real-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new MockLlmClient()
    });
    const confirmation = createMissingOwnerActionConfirmation(repos, { recipient: null });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        event: {
          operator: {
            user_id: {
              open_id: "ou_callback_user"
            }
          },
          action: {
            value: {
              confirmation_id: confirmation.id,
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已确认，处理完成"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(response.json().card)).toContain("已添加待办");
    expect(response.json().toast.type).not.toBe("error");

    expect(repos.getActionItem(confirmation.target_id)).toMatchObject({
      owner: "ou_callback_user",
      confirmation_status: "created",
      feishu_task_guid: `dry_task_${confirmation.target_id}`,
      task_url: `mock://feishu/task/${confirmation.target_id}`
    });
    expect(repos.getConfirmationRequest(confirmation.id)).toMatchObject({
      status: "executed",
      error: null
    });
    const taskRuns = repos.listCliRuns().filter((run) => run.tool === "lark.task.create");
    expect(taskRuns).toHaveLength(1);
    expect(JSON.parse(taskRuns[0].args_json) as string[]).toEqual(
      expect.arrayContaining(["--assignee", "ou_callback_user"])
    );
  });

  it("fails missing-owner action creation when no personal owner open_id is available", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        larkVerificationToken: null,
        larkCliBin: "definitely-not-real-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new MockLlmClient()
    });
    const confirmation = createMissingOwnerActionConfirmation(repos, { recipient: null });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        event: {
          action: {
            value: {
              confirmation_id: confirmation.id,
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toast: {
        type: "error",
        content: expect.stringContaining("确认执行失败")
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(response.json().card)).toContain("添加失败");

    expect(repos.getConfirmationRequest(confirmation.id)).toMatchObject({
      status: "failed",
      error:
        "Cannot create personal Feishu task: missing confirmation recipient open_id or card callback open_id"
    });
    expect(repos.getActionItem(confirmation.target_id)).toMatchObject({
      owner: null,
      confirmation_status: "sent",
      feishu_task_guid: null,
      task_url: null
    });
    expect(repos.listCliRuns().filter((run) => run.tool === "lark.task.create")).toHaveLength(0);
  });

  it("marks the confirmation failed when synchronous confirm execution throws", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        larkVerificationToken: null,
        larkCliBin: "definitely-not-real-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new MockLlmClient()
    });
    const confirmation = repos.createConfirmationRequest({
      id: "conf_archive_wrong_confirm_action",
      request_type: "archive_source",
      target_id: "src_wrong_confirm_action",
      recipient: "ou_owner",
      card_message_id: null,
      status: "sent",
      original_payload_json: JSON.stringify({
        title: "竞品资料",
        source_type: "web",
        url: "https://example.com/source",
        reason: "这份资料和当前会议知识库相关。",
        meeting_reference: "客户访谈复盘"
      }),
      edited_payload_json: null,
      confirmed_at: null,
      executed_at: null,
      error: null
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        event: {
          action: {
            value: {
              confirmation_id: confirmation.id,
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toast: {
        type: "error",
        content: expect.stringContaining("确认执行失败")
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(response.json().card)).toContain("添加失败");
    expect(repos.getConfirmationRequest(confirmation.id)).toMatchObject({
      status: "failed",
      error: "Request type is not executable in current phase: archive_source"
    });
  });

  it("treats legacy complete-owner callbacks as add-to-my-todo", async () => {
    const { app, repos, confirmation } = createOwnerCompletionApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        event: {
          action: {
            value: {
              confirmation_id: confirmation.id,
              action_key: "complete_owner",
              edited_payload: "$editable_fields"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().toast.type).toBe("success");

    expect(JSON.stringify(response.json().card)).not.toContain("补全负责人");
    expect(JSON.stringify(response.json().card)).not.toContain('"tag":"select_person"');
    expect(repos.getActionItem(confirmation.target_id)?.owner).toBe("ou_organizer");
    expect(repos.getConfirmationRequest(confirmation.id)?.status).toBe("executed");
    const taskRuns = repos.listCliRuns().filter((run) => run.tool === "lark.task.create");
    expect(taskRuns).toHaveLength(1);
    expect(JSON.parse(taskRuns[0].args_json) as string[]).toEqual(
      expect.arrayContaining(["--assignee", "ou_organizer"])
    );
  });

  it("returns an executed card and updates the original card after confirm clicks", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const updateCalls: string[][] = [];
    const verificationToken = "verification-token";
    const runner: LarkCliRunner = async (_bin, args) => {
      updateCalls.push(args);
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    };
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        feishuCardSendDryRun: false,
        larkVerificationToken: verificationToken,
        larkCliBin: "fake-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new MockLlmClient(),
      larkCliRunner: runner
    });
    const confirmation = createDirectActionConfirmation(repos);
    const payload = {
      event: {
        token: "card_action_update_token",
        context: {
          open_message_id: "om_original_card",
          open_chat_id: "oc_card_chat"
        },
        action: {
          value: {
            confirmation_id: confirmation.id,
            action_key: "confirm"
          }
        }
      }
    };
    const timestamp = currentLarkTimestamp();
    const nonce = "card-status-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json();
    expect(responseBody).toMatchObject({
      toast: {
        type: "success",
        content: "已确认，处理完成"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(responseBody.card)).toContain("已添加待办");
    expect(JSON.stringify(responseBody.card)).not.toContain("正在添加到飞书");
    expect(JSON.stringify(responseBody.card)).not.toContain("disabled");
    expect(
      responseBody.card.elements.find((element: { tag: string }) => element.tag === "action")
    ).toBeUndefined();

    expect(repos.getConfirmationRequest(confirmation.id)).toMatchObject({
      status: "executed",
      card_message_id: "om_original_card"
    });
    const cardUpdateRuns = repos.listCliRuns().filter((run) => run.tool === "lark.im.update_card");
    expect(cardUpdateRuns).toHaveLength(1);
    expect(cardUpdateRuns.every((run) => run.status === "success")).toBe(true);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toEqual(
      expect.arrayContaining(["api", "POST", "/open-apis/interactive/v1/card/update", "--data"])
    );
    const updateData = JSON.parse(dataArg(updateCalls[0])) as {
      token: string;
      card: { config: unknown; elements: Array<{ tag: string }> };
    };
    expect(updateData.token).toBe("card_action_update_token");
    expect(updateData.card.config).toMatchObject({ update_multi: true });
    expect(JSON.stringify(updateData.card)).toContain("已添加待办");
    expect(JSON.stringify(updateData.card)).toContain("飞书任务");
    expect(JSON.stringify(updateData.card)).toContain(
      `mock://feishu/task/${confirmation.target_id}`
    );
    expect(JSON.stringify(updateData.card)).not.toContain("disabled");
    expect(updateData.card.elements.some((element) => element.tag === "action")).toBe(false);
    expect(updateCalls[0]).not.toContain("--params");
    expect(
      repos.listCliRuns().some((run) => run.tool === "lark.im.send_card_status_fallback")
    ).toBe(false);
  });

  it("updates executed create_kb cards with wiki result links", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const updateCalls: string[][] = [];
    const verificationToken = "verification-token";
    const runner: LarkCliRunner = async (_bin, args) => {
      updateCalls.push(args);
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    };
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        feishuCardSendDryRun: false,
        larkVerificationToken: verificationToken,
        larkCliBin: "fake-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new MockLlmClient(),
      larkCliRunner: runner
    });
    const confirmation = createDirectCreateKbConfirmation(repos);
    const payload = {
      event: {
        token: "card_action_update_token",
        context: {
          open_message_id: "om_create_kb_card",
          open_chat_id: "oc_card_chat"
        },
        action: {
          value: {
            confirmation_id: confirmation.id,
            action_key: "create_kb"
          }
        }
      }
    };
    const timestamp = currentLarkTimestamp();
    const nonce = "create-kb-card-status-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已确认，处理完成"
      },
      card: expect.any(Object)
    });

    const executed = repos.getConfirmationRequest(confirmation.id);
    expect(executed).toMatchObject({
      status: "executed",
      card_message_id: "om_create_kb_card"
    });
    expect(JSON.parse(executed?.edited_payload_json ?? "{}")).toMatchObject({
      result_links: {
        wiki_url: expect.stringContaining("mock://feishu/wiki/"),
        homepage_url: expect.stringContaining("mock://feishu/wiki/")
      }
    });
    expect(updateCalls).toHaveLength(1);
    const updateData = JSON.parse(dataArg(updateCalls[0])) as {
      token: string;
      card: { config: unknown; elements: Array<{ tag: string }> };
    };
    const updatedCardJson = JSON.stringify(updateData.card);
    expect(updateData.token).toBe("card_action_update_token");
    expect(updatedCardJson).toContain("已创建知识库");
    expect(updatedCardJson).toContain("知识库");
    expect(updatedCardJson).toContain("首页");
    expect(updatedCardJson).toContain("mock://feishu/wiki/");
    expect(updateData.card.elements.some((element) => element.tag === "action")).toBe(false);
  });

  it("falls back to a valid result card when final card update fails after execution failure", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const verificationToken = "verification-token";
    const runner: LarkCliRunner = async (_bin, args) => {
      if (args[0] === "api" && args[1] === "PATCH") {
        throw new Error("card update API unavailable");
      }

      if (args[0] === "task" && args[1] === "+create") {
        throw new Error("fake task create failure");
      }

      if (args[0] === "im" && args[1] === "+messages-send") {
        return {
          stdout: JSON.stringify({ message_id: "om_status_fallback" }),
          stderr: ""
        };
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: false,
        feishuCardSendDryRun: false,
        larkVerificationToken: verificationToken,
        larkCliBin: "fake-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new MockLlmClient(),
      larkCliRunner: runner
    });
    const confirmation = createDirectActionConfirmation(repos, {
      cardMessageId: "om_existing_card"
    });
    const payload = {
      event: {
        context: {
          open_chat_id: "oc_card_chat"
        },
        action: {
          value: {
            confirmation_id: confirmation.id,
            action_key: "confirm"
          }
        }
      }
    };
    const timestamp = currentLarkTimestamp();
    const nonce = "card-fallback-nonce";

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signLegacyCardAction({
          timestamp,
          nonce,
          body: payload,
          verificationToken
        })
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      toast: {
        type: "error",
        content: expect.stringContaining("确认执行失败")
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(response.json().card)).toContain("添加失败");

    expect(repos.getConfirmationRequest(confirmation.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("lark.task.create failed")
    });
    const runs = repos.listCliRuns();
    expect(runs.map((run) => run.tool)).toEqual([
      "lark.task.create",
      "lark.im.update_card",
      "lark.im.send_card_status_fallback"
    ]);
    expect(runs[1]).toMatchObject({
      tool: "lark.im.update_card",
      status: "failed"
    });
    expect(runs[2]).toMatchObject({
      tool: "lark.im.send_card_status_fallback",
      status: "success"
    });
    const fallbackArgs = JSON.parse(runs[2].args_json) as string[];
    expect(fallbackArgs).toEqual(expect.arrayContaining(["--chat-id", "oc_card_chat"]));
    const fallbackCard = JSON.parse(contentArg(fallbackArgs)) as {
      config: unknown;
      elements: Array<{ tag: string }>;
    };
    expect(fallbackCard.config).toMatchObject({ update_multi: true });
    expect(JSON.stringify(fallbackCard)).toContain("添加失败");
    expect(JSON.stringify(fallbackCard)).toContain("fake task create failure");
    expect(JSON.stringify(fallbackCard)).not.toContain("disabled");
    expect(fallbackCard.elements.some((element) => element.tag === "action")).toBe(false);
    expect(JSON.stringify(runs[1].args_json)).toContain(
      "/open-apis/im/v1/messages/om_existing_card"
    );
    expect(JSON.stringify(runs[1].args_json)).not.toContain("--params");
  });

  it("returns already_processed toast for repeated terminal clicks without re-executing", async () => {
    const { app, repos, action } = await createAppWithConfirmations();

    await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        action: {
          value: {
            confirmation_id: action.id,
            action: "confirm"
          }
        }
      }
    });
    await flushAsyncWork();
    const cliRunsAfterFirstClick = repos.listCliRuns().length;
    expect(repos.getConfirmationRequest(action.id)?.status).toBe("executed");

    const duplicateResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        event: {
          action: {
            value: {
              confirmation_id: action.id,
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(duplicateResponse.statusCode).toBe(200);
    expect(duplicateResponse.json()).toMatchObject({
      toast: {
        type: "info",
        content: expect.stringContaining("不会重复执行")
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(duplicateResponse.json().card)).toContain("已添加待办");
    expect(repos.listCliRuns()).toHaveLength(cliRunsAfterFirstClick);

    repos.updateConfirmationRequest({
      id: action.id,
      status: "failed",
      error: "lark.task.create failed: fake task error"
    });
    const failedRunsBeforeClick = repos.listCliRuns().length;
    const failedDuplicateResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        event: {
          action: {
            value: {
              confirmation_id: action.id,
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(failedDuplicateResponse.statusCode).toBe(200);
    expect(failedDuplicateResponse.json()).toMatchObject({
      toast: {
        type: "info",
        content: expect.stringContaining("不会重复执行")
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(failedDuplicateResponse.json().card)).toContain("添加失败");
    expect(repos.listCliRuns()).toHaveLength(failedRunsBeforeClick);
  });

  it("turns card helper actions into local confirmation state", async () => {
    const { app, repos, action, calendar, createKb } = await createAppWithConfirmations();
    expect(repos.getConfirmationRequest(action.id)?.status).toBe("sent");

    const remindResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: action.id,
            action: "remind_later"
          }
        }
      }
    });
    expect(remindResponse.statusCode).toBe(200);
    expect(remindResponse.json()).toMatchObject({
      toast: {
        type: "success",
        content: "好的，30 分钟后再提醒你"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(remindResponse.json().card)).toContain("好的，30 分钟后再提醒你");
    expect(repos.getConfirmationRequest(action.id)).toMatchObject({
      status: "snoozed",
      snooze_until: expect.any(String)
    });
    expect(
      JSON.parse(repos.getConfirmationRequest(action.id)?.edited_payload_json ?? "{}")
    ).toMatchObject({
      card_action: "remind_later",
      snooze: {
        minutes: 30
      }
    });

    const actionConfirmationsBeforeConvert = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "action").length;
    const convertResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        action: {
          value: {
            confirmation_id: calendar.id,
            action: "convert_to_task"
          }
        }
      }
    });
    expect(convertResponse.statusCode).toBe(200);
    expect(convertResponse.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已转成待办确认卡"
      },
      card: expect.any(Object)
    });
    const convertCardJson = JSON.stringify(convertResponse.json().card);
    expect(convertCardJson).toContain("无人机操作员访谈准备事项");
    expect(convertCardJson).not.toContain("跟进：无人机操作员访谈");
    expect(repos.getConfirmationRequest(calendar.id)).toMatchObject({
      status: "rejected",
      error: "converted_to_task"
    });
    const actionConfirmationsAfterConvert = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "action");
    expect(actionConfirmationsAfterConvert).toHaveLength(actionConfirmationsBeforeConvert + 1);
    const convertedAction = repos
      .listActionItems()
      .find((item) => item.title === "无人机操作员访谈准备事项");
    expect(convertedAction).toMatchObject({
      meeting_id: repos.getCalendarDraft(calendar.target_id)?.meeting_id,
      owner: null,
      due_date: null,
      suggested_reason: expect.stringContaining("Mock LLM"),
      confirmation_status: "sent"
    });
    expect(JSON.parse(convertedAction!.missing_fields_json)).toEqual(
      expect.arrayContaining(["owner", "due_date"])
    );

    const appendResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        action: {
          value: {
            confirmation_id: createKb.id,
            action: "append_current_only"
          }
        }
      }
    });
    expect(appendResponse.statusCode).toBe(200);
    expect(appendResponse.json()).toMatchObject({
      toast: {
        type: "success",
        content: "已转为仅归档当前会议确认"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(appendResponse.json().card)).toContain("客户访谈知识库");
    expect(repos.getConfirmationRequest(createKb.id)).toMatchObject({
      status: "rejected",
      error: "append_current_only"
    });
    expect(
      repos.listConfirmationRequests().some((request) => request.request_type === "append_meeting")
    ).toBe(true);
    expect(repos.listKnowledgeBases().some((kb) => kb.status === "candidate")).toBe(true);
    expect(JSON.stringify(remindResponse.json())).not.toContain("暂未实现");
    expect(JSON.stringify(convertResponse.json())).not.toContain("暂未实现");
    expect(JSON.stringify(appendResponse.json())).not.toContain("暂未实现");
  });
});
