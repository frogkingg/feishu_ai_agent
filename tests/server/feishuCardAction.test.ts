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

  return {
    app,
    repos,
    action: action as ConfirmationRequestRow,
    calendar: calendar as ConfirmationRequestRow
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
    const timestamp = "1777574290";
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

  it("rejects invalid legacy Feishu card-action signatures", async () => {
    const { app } = await createAppWithConfirmations("verification-token");

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      headers: {
        "x-lark-request-timestamp": "1777574290",
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
        type: "info",
        content: "已收到请求，正在添加到飞书…"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(confirmResponse.json().card)).toContain("正在添加到飞书...");
    await flushAsyncWork();
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
        type: "info",
        content: "已收到请求，正在添加到飞书…"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(response.json().card)).toContain("正在添加到飞书...");
    await flushAsyncWork();

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
        type: "info",
        content: "已收到请求，正在添加到飞书…"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(response.json().card)).toContain("正在添加到飞书...");
    expect(JSON.stringify(response.json().card)).not.toContain("补全负责人");
    expect(JSON.stringify(response.json().card)).not.toContain('"tag":"select_person"');
    await flushAsyncWork();

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
        type: "info",
        content: "已收到请求，正在添加到飞书…"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(response.json().card)).toContain("正在添加到飞书...");
    expect(response.json().toast.type).not.toBe("error");
    await flushAsyncWork();

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
    expect(response.json().toast.type).toBe("info");
    await flushAsyncWork();

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
    expect(response.json().toast.type).toBe("info");
    await flushAsyncWork();

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

  it("returns a processing card and then updates the original card to executed after confirm clicks", async () => {
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
    const timestamp = "1777574291";
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
        type: "info",
        content: "已收到请求，正在添加到飞书…"
      },
      card: expect.any(Object)
    });
    expect(JSON.stringify(responseBody.card)).toContain("正在添加到飞书...");
    expect(JSON.stringify(responseBody.card)).not.toContain("添加待办");
    expect(JSON.stringify(responseBody.card)).not.toContain("disabled");
    expect(
      responseBody.card.elements.find((element: { tag: string }) => element.tag === "action")
    ).toBeUndefined();
    await flushAsyncWork();

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
    expect(JSON.stringify(updateData.card)).not.toContain("disabled");
    expect(updateData.card.elements.some((element) => element.tag === "action")).toBe(false);
    expect(updateCalls[0]).not.toContain("--params");
    expect(
      repos.listCliRuns().some((run) => run.tool === "lark.im.send_card_status_fallback")
    ).toBe(false);
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
    const timestamp = "1777574292";
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
        type: "info",
        content: "已收到请求，正在添加到飞书…"
      },
      card: expect.any(Object)
    });
    await flushAsyncWork();

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

  it("keeps preview-only card actions side-effect free before later confirmation", async () => {
    const { app, repos, action } = await createAppWithConfirmations();
    expect(repos.getConfirmationRequest(action.id)?.status).toBe("sent");

    for (const callbackAction of ["remind_later", "convert_to_task", "append_current_only"]) {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/feishu/card-action",
        payload: {
          open_id: "ou_test",
          action: {
            value: {
              confirmation_id: action.id,
              action: callbackAction
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        toast: {
          type: "info",
          content: "此操作暂未实现，将在 PR-2 中完成"
        },
        card: expect.any(Object)
      });
      expect(JSON.stringify(response.json().card)).toContain("已收到，稍后处理");
    }

    const unchangedConfirmation = repos.getConfirmationRequest(action.id);
    expect(unchangedConfirmation?.status).toBe("sent");
    expect(unchangedConfirmation?.edited_payload_json).toBeNull();
    expect(
      repos.listCliRuns().filter((run) => run.tool.startsWith("lark.card_action."))
    ).toHaveLength(0);

    const confirmResponse = await app.inject({
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

    expect(confirmResponse.statusCode).toBe(200);
    await flushAsyncWork();
    const confirmed = repos.getConfirmationRequest(action.id);
    expect(confirmed?.status).toBe("executed");
    expect(confirmed?.edited_payload_json).toBeNull();
  });
});
