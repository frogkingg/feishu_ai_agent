import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { createConfirmationRequest } from "../../src/services/confirmationService";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

function createApp(config: Parameters<typeof loadConfig>[0] = {}) {
  const repos = createRepositories(createMemoryDatabase());
  const app = buildServer({
    config: loadConfig({ sqlitePath: ":memory:", ...config }),
    repos,
    llm: new MockLlmClient()
  });

  return { app, repos };
}

function createActionConfirmation(repos: ReturnType<typeof createRepositories>) {
  const meeting = repos.createMeeting({
    id: "mtg_card_callback",
    external_meeting_id: null,
    title: "无人机操作方案初步访谈",
    started_at: "2026-04-28T10:00:00+08:00",
    ended_at: "2026-04-28T11:00:00+08:00",
    organizer: "张三",
    participants_json: JSON.stringify(["张三", "李四"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "李四负责确认试飞场地权限。",
    summary: null,
    keywords_json: JSON.stringify([]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 1,
    calendar_count: 0
  });
  const action = repos.createActionItem({
    id: "act_card_callback",
    meeting_id: meeting.id,
    kb_id: null,
    title: "确认试飞场地权限",
    description: "确认测试场地是否具备无人机试飞条件。",
    owner: "李四",
    collaborators_json: JSON.stringify([]),
    due_date: "2026-05-01",
    priority: "P1",
    evidence: "李四负责确认试飞场地权限。",
    confidence: 0.86,
    suggested_reason: "会议明确指派李四负责。",
    missing_fields_json: JSON.stringify([]),
    confirmation_status: "sent",
    feishu_task_guid: null,
    task_url: null,
    rejection_reason: null
  });

  return createConfirmationRequest({
    repos,
    requestType: "action",
    targetId: action.id,
    recipient: action.owner,
    originalPayload: { draft: action }
  });
}

function createCalendarConfirmation(repos: ReturnType<typeof createRepositories>) {
  const meeting = repos.createMeeting({
    id: "mtg_card_callback_calendar",
    external_meeting_id: null,
    title: "无人机操作方案初步访谈",
    started_at: "2026-04-28T10:00:00+08:00",
    ended_at: "2026-04-28T11:00:00+08:00",
    organizer: "张三",
    participants_json: JSON.stringify(["张三", "李四"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "下周二上午 10 点再约无人机操作员访谈。",
    summary: null,
    keywords_json: JSON.stringify([]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 0,
    calendar_count: 1
  });
  const calendar = repos.createCalendarDraft({
    id: "cal_card_callback",
    meeting_id: meeting.id,
    kb_id: null,
    title: "无人机操作员访谈",
    start_time: "2026-05-05T10:00:00+08:00",
    end_time: "2026-05-05T11:00:00+08:00",
    duration_minutes: 60,
    participants_json: JSON.stringify(["张三", "李四"]),
    agenda: "确认真实操作步骤和限制",
    location: "线上会议室",
    evidence: "下周二上午 10 点再约无人机操作员访谈。",
    confidence: 0.82,
    missing_fields_json: JSON.stringify([]),
    confirmation_status: "sent",
    calendar_event_id: null,
    event_url: null
  });

  return createConfirmationRequest({
    repos,
    requestType: "calendar",
    targetId: calendar.id,
    recipient: meeting.organizer,
    originalPayload: { draft: calendar }
  });
}

function createCreateKbConfirmation(repos: ReturnType<typeof createRepositories>) {
  const firstMeeting = repos.createMeeting({
    id: "mtg_card_callback_kb_1",
    external_meeting_id: null,
    title: "无人机操作方案初步访谈",
    started_at: "2026-04-28T10:00:00+08:00",
    ended_at: "2026-04-28T11:00:00+08:00",
    organizer: "张三",
    participants_json: JSON.stringify(["张三", "李四"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "讨论无人机现有操作流程和场地权限。",
    summary: "初步梳理无人机操作方案。",
    keywords_json: JSON.stringify(["无人机", "操作方案"]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 0,
    calendar_count: 0
  });
  const secondMeeting = repos.createMeeting({
    id: "mtg_card_callback_kb_2",
    external_meeting_id: null,
    title: "无人机操作方案复盘",
    started_at: "2026-04-29T10:00:00+08:00",
    ended_at: "2026-04-29T11:00:00+08:00",
    organizer: "张三",
    participants_json: JSON.stringify(["张三", "李四"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: "继续讨论无人机风险清单和访谈安排。",
    summary: "补充无人机操作方案风险和访谈计划。",
    keywords_json: JSON.stringify(["无人机", "风险清单"]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 0,
    calendar_count: 0
  });

  return createConfirmationRequest({
    repos,
    requestType: "create_kb",
    targetId: "kb_drone_operation_plan",
    recipient: "张三",
    originalPayload: {
      topic_name: "无人机操作方案",
      suggested_goal: "沉淀无人机操作流程、风险清单和访谈计划。",
      candidate_meeting_ids: [firstMeeting.id, secondMeeting.id],
      topic_match: {
        current_meeting_id: secondMeeting.id,
        matched_kb_id: null,
        matched_kb_name: null,
        score: 0.91,
        match_reasons: ["两场会议都围绕无人机操作方案展开"],
        suggested_action: "ask_create",
        candidate_meeting_ids: [firstMeeting.id, secondMeeting.id]
      }
    }
  });
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
});

describe("POST /webhooks/feishu/card", () => {
  it("returns the Feishu card challenge value", async () => {
    const { app } = createApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload: { challenge: "card-challenge-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "card-challenge-token" });
  });

  it("accepts card callbacks without actionable request metadata", async () => {
    const { app, repos } = createApp({ feishuDryRun: true });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload: {
        event: {
          type: "card.action.trigger",
          action: {
            value: {}
          }
        }
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      callback: "feishu.card",
      dry_run: true,
      normalized_preview: {
        request_id: null,
        action_key: null,
        has_edited_payload: false
      },
      message: "Feishu card callback accepted without actionable request_id/action_key"
    });
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("returns 404 when request_id is not found", async () => {
    const { app, repos } = createApp({ feishuDryRun: true });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload: {
        event: {
          action: {
            value: {
              request_id: "conf_missing_card_callback",
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "Confirmation request not found: conf_missing_card_callback"
    });
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("maps confirm button callbacks to dry-run confirmation execution", async () => {
    const { app, repos } = createApp({
      feishuDryRun: true,
      feishuCardSendDryRun: false,
      larkCliBin: "lark-cli"
    });
    const confirmation = createActionConfirmation(repos);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload: {
        event: {
          action: {
            value: {
              request_id: confirmation.id,
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      dry_run: true,
      callback: "feishu.card",
      action_key: "confirm",
      request_id: confirmation.id,
      handled_as: "confirm",
      confirmation: {
        status: "executed"
      }
    });
    expect(repos.getConfirmationRequest(confirmation.id)?.status).toBe("executed");
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.task.create",
      dry_run: 1,
      status: "planned"
    });
  });

  it("does not repeat CLI execution when an executed confirmation is confirmed again", async () => {
    const { app, repos } = createApp({ feishuDryRun: true });
    const confirmation = createActionConfirmation(repos);
    const payload = {
      action: {
        value: {
          request_id: confirmation.id,
          action_key: "confirm"
        }
      }
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toMatchObject({
      ok: true,
      dry_run: true,
      handled_as: "confirm",
      confirmation: {
        status: "executed"
      },
      result: {
        already_executed: true
      }
    });
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.task.create",
      dry_run: 1,
      status: "planned"
    });
  });

  it("keeps calendar callback confirmation dry-run", async () => {
    const { app, repos } = createApp({
      feishuDryRun: true,
      feishuCardSendDryRun: false,
      larkCliBin: "definitely-not-real-lark"
    });
    const confirmation = createCalendarConfirmation(repos);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload: {
        event: {
          action: {
            value: {
              request_id: confirmation.id,
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      dry_run: true,
      callback: "feishu.card",
      action_key: "confirm",
      request_id: confirmation.id,
      handled_as: "confirm",
      confirmation: {
        status: "executed"
      },
      result: {
        dry_run: true,
        calendar_event_id: expect.stringContaining("dry_event_"),
        event_url: expect.stringContaining("mock://feishu/calendar/")
      }
    });
    expect(repos.getCalendarDraft(confirmation.target_id)).toMatchObject({
      confirmation_status: "created",
      calendar_event_id: expect.stringContaining("dry_event_"),
      event_url: expect.stringContaining("mock://feishu/calendar/")
    });
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.calendar.create",
      dry_run: 1,
      status: "planned",
      error: null
    });
  });

  it("parses top-level card value metadata for create_kb dry-run callbacks", async () => {
    const { app, repos } = createApp({ feishuDryRun: true });
    const confirmation = createCreateKbConfirmation(repos);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload: {
        value: {
          request_id: confirmation.id,
          action_key: "create_kb"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      dry_run: true,
      callback: "feishu.card",
      action_key: "create_kb",
      request_id: confirmation.id,
      handled_as: "confirm",
      confirmation: {
        status: "executed"
      },
      result: {
        dry_run: true,
        knowledge_base: {
          name: "无人机操作方案",
          wiki_url: expect.stringMatching(/^mock:\/\/feishu\/wiki\//)
        }
      }
    });
    expect(repos.getConfirmationRequest(confirmation.id)?.status).toBe("executed");
    expect(repos.listKnowledgeBases()).toHaveLength(1);
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("maps reject button callbacks to dry-run rejection", async () => {
    const { app, repos } = createApp({ feishuDryRun: true });
    const confirmation = createActionConfirmation(repos);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload: {
        action: {
          value: {
            request_id: confirmation.id,
            action_key: "reject"
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      dry_run: true,
      handled_as: "reject",
      action_key: "reject",
      confirmation: {
        status: "rejected",
        error: "reject"
      }
    });
    expect(repos.getConfirmationRequest(confirmation.id)?.status).toBe("rejected");
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("keeps preview-only card callback actions side-effect free", async () => {
    const { app, repos } = createApp({ feishuDryRun: true });
    const confirmation = createActionConfirmation(repos);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload: {
        event: {
          action: {
            value: {
              request_id: confirmation.id,
              action_key: "remind_later"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      dry_run: true,
      handled_as: "preview_stub",
      action: "remind_later",
      message: "This card action is preview-only in the current phase."
    });
    expect(repos.getConfirmationRequest(confirmation.id)?.status).toBe("sent");
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("refuses to process callbacks when Feishu write dry-run is disabled", async () => {
    const { app, repos } = createApp({ feishuDryRun: false });
    const confirmation = createActionConfirmation(repos);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card",
      payload: {
        event: {
          action: {
            value: {
              request_id: confirmation.id,
              action_key: "confirm"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      ok: false,
      dry_run: false,
      error: "Feishu card callback skeleton only runs when FEISHU_DRY_RUN=true"
    });
    expect(repos.getConfirmationRequest(confirmation.id)?.status).toBe("sent");
    expect(repos.listCliRuns()).toHaveLength(0);
  });
});
