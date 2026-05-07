import {
  buildActionConfirmationCard,
  buildAppendMeetingConfirmationCard,
  buildCalendarConfirmationCard,
  buildConfirmationCardFromRequest,
  buildCreateKbConfirmationCard,
  buildGenericConfirmationCard
} from "../../src/agents/cardInteractionAgent";
import { DryRunConfirmationCardSchema } from "../../src/schemas";
import { createMemoryDatabase } from "../../src/services/store/db";
import { ConfirmationRequestRow, createRepositories } from "../../src/services/store/repositories";

const actionDraft = {
  title: "整理无人机操作流程",
  description: "把现有操作步骤整理成清单。",
  owner: "张三",
  collaborators: ["李四"],
  due_date: "2026-05-01",
  priority: "P1",
  evidence: "张三：我可以整理现有操作流程，2026-05-01 前给大家看。",
  confidence: 0.91,
  suggested_reason: "会议中明确了负责人和截止时间。",
  missing_fields: []
} as const;

const calendarDraft = {
  title: "无人机操作员访谈会议",
  start_time: "2026-05-05T10:00:00+08:00",
  end_time: null,
  duration_minutes: 60,
  participants: ["张三", "王五"],
  agenda: "确认真实操作步骤和限制。",
  location: null,
  evidence: "下周二上午 10 点我们再约操作员访谈。",
  confidence: 0.84,
  missing_fields: ["location"]
} as const;

function expectValidCard(card: unknown) {
  return DryRunConfirmationCardSchema.parse(card);
}

describe("CardInteractionAgent", () => {
  it("builds action confirmation dry-run card JSON", () => {
    const card = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_action",
        target_id: "act_001",
        recipient: "张三",
        status: "sent",
        original_payload: {
          draft: actionDraft,
          meeting_id: "mtg_001"
        }
      })
    );

    expect(card).toMatchObject({
      card_type: "action_confirmation",
      title: "待办建议：整理无人机操作流程",
      summary: "建议负责人：张三；截止：2026-05-01；优先级：P1",
      dry_run: true
    });
    expect(card.editable_fields.map((field) => field.key)).toEqual([
      "title",
      "owner",
      "due_date",
      "priority",
      "collaborators"
    ]);
    expect(card.sections.flatMap((section) => section.fields.map((field) => field.key))).toEqual([
      "title",
      "recommended_owner",
      "due_date",
      "priority",
      "suggested_reason",
      "evidence",
      "confidence"
    ]);
    expect(JSON.stringify(card)).toContain("会议中明确了负责人和截止时间。");
    expect(JSON.stringify(card)).toContain("张三：我可以整理现有操作流程");
    expect(JSON.stringify(card)).toContain("0.91");
    expect(JSON.stringify(card)).not.toContain("meeting_id");
    expect(card.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject"
    ]);
    expect(card.actions.find((action) => action.key === "confirm")?.payload_template).toEqual({});
    expect(
      card.actions.find((action) => action.key === "confirm_with_edits")?.payload_template
    ).toEqual({
      edited_payload: "$editable_fields"
    });
  });

  it("shows pending confirmation when action owner is not supported by meeting evidence", () => {
    const card = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_action_no_owner",
        target_id: "act_no_owner",
        recipient: "ou_recipient",
        status: "sent",
        original_payload: {
          draft: {
            ...actionDraft,
            owner: null,
            evidence: "会议中提出需要整理操作流程，但没有明确负责人。",
            suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。",
            missing_fields: ["owner"]
          },
          meeting_id: "mtg_001"
        }
      })
    );

    const visibleText = JSON.stringify({
      title: card.title,
      summary: card.summary,
      sections: card.sections,
      editable_fields: card.editable_fields
    });
    expect(card.summary).toContain("负责人待补充");
    expect(card.summary).not.toContain("可在卡片中填写负责人后添加");
    expect(
      card.sections[0]?.fields.find((field) => field.key === "recommended_owner")
    ).toMatchObject({
      label: "负责人",
      value: "待确认"
    });
    expect(visibleText).not.toContain("ou_recipient");
    expect(visibleText).not.toContain("Henry");
    expect(visibleText).not.toContain("补全负责人");
    expect(visibleText).not.toContain("select_person");
    expect(visibleText).not.toContain("我的个人待办");
    expect(card.editable_fields.find((field) => field.key === "owner")).toMatchObject({
      label: "负责人",
      input_type: "text",
      value: null,
      required: true
    });
    expect(card.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject"
    ]);
    expect(card.status_text).toBe("负责人待补充，可在飞书任务中补齐后添加");
  });

  it("keeps edited missing-owner cards editable", () => {
    const card = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_personal_todo",
        target_id: "act_personal_todo",
        recipient: "ou_recipient",
        status: "edited",
        original_payload: {
          draft: {
            ...actionDraft,
            owner: null,
            evidence: "会议中提出需要整理操作流程，但没有明确负责人。",
            suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。",
            missing_fields: ["owner"]
          }
        }
      })
    );

    expect(card).toMatchObject({
      card_type: "action_confirmation",
      title: "待办建议：整理无人机操作流程",
      status_text: "负责人待补充，可在飞书任务中补齐后添加"
    });
    expect(JSON.stringify(card)).toContain("还缺什么");
    expect(JSON.stringify(card)).not.toContain("我的个人待办");
    expect(JSON.stringify(card)).not.toContain("补全负责人");
    expect(JSON.stringify(card)).not.toContain("select_person");
    expect(card.editable_fields.find((field) => field.key === "owner")).toMatchObject({
      label: "负责人",
      input_type: "text",
      value: null,
      required: true
    });
    expect(card.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject"
    ]);
    expect(JSON.stringify(card)).not.toContain("@确认待办");
    expect(JSON.stringify(card)).not.toContain("Henry");
  });

  it("builds calendar confirmation dry-run card JSON", () => {
    const card = expectValidCard(
      buildCalendarConfirmationCard({
        id: "conf_calendar",
        target_id: "cal_001",
        recipient: "张三",
        status: "sent",
        original_payload: {
          draft: calendarDraft,
          meeting_id: "mtg_001"
        }
      })
    );

    expect(card.card_type).toBe("calendar_confirmation");
    expect(card.title).toBe("日程建议：无人机操作员访谈会议");
    expect(card.summary).toContain("开始：2026-05-05T10:00:00+08:00");
    expect(card.summary).toContain("参会人：张三, 王五");
    expect(card.summary).toContain("地点待补充");
    expect(card.sections.flatMap((section) => section.fields.map((field) => field.key))).toEqual([
      "title",
      "start_time",
      "end_time",
      "duration_minutes",
      "participants",
      "location",
      "agenda",
      "missing_fields",
      "evidence",
      "confidence"
    ]);
    expect(JSON.stringify(card)).toContain("confidence");
    expect(JSON.stringify(card)).toContain("location");
    expect(JSON.stringify(card)).toContain("下周二上午 10 点我们再约操作员访谈。");
    expect(JSON.stringify(card)).not.toContain("meeting_id");
    expect(card.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject",
      "convert_to_task"
    ]);
    expect(card.actions.find((action) => action.key === "confirm")?.payload_template).toEqual({});
    expect(
      card.actions.find((action) => action.key === "confirm_with_edits")?.payload_template
    ).toEqual({
      edited_payload: "$editable_fields"
    });
  });

  it("cleans filled calendar end time and duration before rendering missing fields", () => {
    const card = expectValidCard(
      buildCalendarConfirmationCard({
        id: "conf_calendar_clean_missing",
        target_id: "cal_clean_missing",
        recipient: "张三",
        status: "sent",
        original_payload: {
          draft: {
            ...calendarDraft,
            end_time: "2026-05-05T11:00:00+08:00",
            duration_minutes: 60,
            missing_fields: ["end_time", "duration_minutes", "location"]
          }
        }
      })
    );

    const missingField = card.sections
      .flatMap((section) => section.fields)
      .find((field) => field.key === "missing_fields");
    expect(missingField).toMatchObject({
      value: ["location"],
      value_text: "location"
    });
  });

  it("builds create_kb confirmation dry-run card JSON", () => {
    const card = expectValidCard(
      buildCreateKbConfirmationCard({
        id: "conf_kb",
        target_id: "kb_candidate_001",
        recipient: "张三",
        status: "sent",
        original_payload: {
          topic_name: "无人机操作方案",
          suggested_goal: "沉淀无人机操作方案相关会议结论。",
          meeting_ids: ["mtg_001", "mtg_002"],
          candidate_meeting_refs: [
            "无人机操作方案初访（会议纪要：https://example.feishu.cn/minutes/min_001）",
            "无人机操作员访谈（转写记录：https://example.feishu.cn/minutes/transcript_002）"
          ],
          match_reasons: ["会议摘要/转写围绕相同主题信号"],
          score: 0.92,
          default_structure: ["00 首页 / 总览", "06 单个会议总结"],
          reason: "检测到至少两场强相关会议，建议创建主题知识库。"
        }
      })
    );

    expect(card.card_type).toBe("create_kb_confirmation");
    expect(card.summary).toContain("关联会议数：2");
    expect(card.summary).toContain("建议：检测到至少两场强相关会议，建议创建主题知识库。");
    expect(JSON.stringify(card)).toContain("https://example.feishu.cn/minutes/min_001");
    expect(card.sections.flatMap((section) => section.fields.map((field) => field.key))).toEqual([
      "topic_name",
      "meeting_count",
      "suggested_goal",
      "reason",
      "candidate_meetings",
      "default_structure"
    ]);
    expect(JSON.stringify(card)).not.toContain("匹配分");
    expect(JSON.stringify(card)).not.toContain("match_reasons");
    expect(card.editable_fields.map((field) => field.key)).toEqual([
      "topic_name",
      "suggested_goal",
      "default_structure"
    ]);
    expect(card.actions.map((action) => action.key)).toEqual([
      "create_kb",
      "edit_and_create",
      "append_current_only",
      "reject",
      "never_remind_topic"
    ]);
  });

  it("renders sent, confirmed, executed, rejected, and failed status cards", () => {
    const sent = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_status_sent",
        target_id: "act_status_sent",
        recipient: "张三",
        status: "sent",
        original_payload: { draft: actionDraft }
      })
    );
    expect(sent.status_text).toBeUndefined();
    expect(sent.actions.map((action) => action.key)).toContain("confirm");

    const confirmed = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_status_confirmed",
        target_id: "act_status_confirmed",
        recipient: "张三",
        status: "confirmed",
        original_payload: { draft: actionDraft }
      })
    );
    expect(confirmed.status_text).toBe("正在添加到飞书...");
    expect(confirmed.actions).toEqual([]);

    const executedAction = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_status_executed_action",
        target_id: "act_status_executed",
        recipient: "张三",
        status: "executed",
        original_payload: { draft: actionDraft }
      })
    );
    expect(executedAction.status_text).toBe("已添加待办");
    expect(executedAction.actions).toEqual([]);

    const executedCalendar = expectValidCard(
      buildCalendarConfirmationCard({
        id: "conf_status_executed_calendar",
        target_id: "cal_status_executed",
        recipient: "张三",
        status: "executed",
        original_payload: { draft: calendarDraft }
      })
    );
    expect(executedCalendar.status_text).toBe("已添加日程");

    const executedKb = expectValidCard(
      buildCreateKbConfirmationCard({
        id: "conf_status_executed_kb",
        target_id: "kb_status_executed",
        recipient: "张三",
        status: "executed",
        original_payload: {
          topic_name: "无人机操作方案",
          meeting_ids: ["mtg_001"],
          default_structure: ["00 首页 / 总览"]
        }
      })
    );
    expect(executedKb.status_text).toBe("已创建知识库");

    const rejectedAction = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_status_rejected_action",
        target_id: "act_status_rejected",
        recipient: "张三",
        status: "rejected",
        original_payload: { draft: actionDraft }
      })
    );
    expect(rejectedAction.status_text).toBe("已不添加");
    expect(rejectedAction.actions).toEqual([]);

    const rejectedKb = expectValidCard(
      buildCreateKbConfirmationCard({
        id: "conf_status_rejected_kb",
        target_id: "kb_status_rejected",
        recipient: "张三",
        status: "rejected",
        original_payload: {
          topic_name: "无人机操作方案",
          meeting_ids: ["mtg_001"],
          default_structure: ["00 首页 / 总览"]
        }
      })
    );
    expect(rejectedKb.status_text).toBe("已拒绝");

    const failed = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_status_failed",
        target_id: "act_status_failed",
        recipient: "张三",
        status: "failed",
        error: "lark.task.create failed: fake task error",
        original_payload: { draft: actionDraft }
      })
    );
    expect(failed.status_text).toBe("添加失败");
    expect(failed.error_summary).toContain("fake task error");
    expect(failed.actions).toEqual([]);
  });

  it("formats open_ids and append-meeting links for card display", () => {
    const actionCard = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_open_id",
        target_id: "act_open_id",
        recipient: "ou_recipient_123456",
        status: "sent",
        original_payload: {
          draft: {
            ...actionDraft,
            owner: "ou_owner_abcdef",
            collaborators: ["ou_helper_654321", "李四"],
            evidence: "ou_owner_abcdef 负责，李四协作。"
          },
          meeting_id: "mtg_001"
        }
      })
    );

    const serializedActionCard = JSON.stringify(actionCard);
    expect(serializedActionCard).not.toContain("ou_recipient_123456");
    expect(serializedActionCard).not.toContain("ou_owner_abcdef");
    expect(serializedActionCard).not.toContain("ou_helper_654321");
    expect(serializedActionCard).toContain("@用户(123456)");
    expect(serializedActionCard).toContain("@用户(abcdef)");
    expect(serializedActionCard).toContain("@用户(654321)");
    expect(serializedActionCard).toContain("李四");

    const appendCard = expectValidCard(
      buildAppendMeetingConfirmationCard({
        id: "conf_append",
        target_id: "mtg_001",
        recipient: "ou_recipient_123456",
        status: "sent",
        original_payload: {
          kb_name: "无人机操作流程主题知识库",
          meeting_id: "mtg_001",
          meeting_title: "无人机操作方案风险评审",
          meeting_reference:
            "无人机操作方案风险评审（转写记录：https://example.feishu.cn/minutes/transcript）",
          meeting_summary: "会议确认继续沉淀风险控制。",
          key_decisions: [{ decision: "继续沉淀风险控制", evidence: "会议明确提出。" }],
          risks: [{ risk: "试飞权限未确认", evidence: "权限仍待确认。" }],
          match_reasons: ["主题高度相关"],
          topic_keywords: ["无人机", "风险控制"],
          score: 0.88
        }
      })
    );

    expect(appendCard.card_type).toBe("append_meeting_confirmation");
    expect(JSON.stringify(appendCard)).toContain("https://example.feishu.cn/minutes/transcript");
    expect(
      appendCard.sections.flatMap((section) => section.fields.map((field) => field.key))
    ).toEqual(["kb_name", "meeting_reference", "meeting_summary", "key_decisions", "risks"]);
    expect(JSON.stringify(appendCard)).not.toContain("match_reasons");
    expect(JSON.stringify(appendCard)).not.toContain("topic_keywords");
    expect(JSON.stringify(appendCard)).not.toContain("匹配分");
    expect(JSON.stringify(appendCard)).not.toContain("ou_recipient_123456");
  });

  it("redacts API keys, Authorization headers, and .env content from card JSON", () => {
    const card = expectValidCard(
      buildActionConfirmationCard({
        id: "conf_secret",
        target_id: "act_secret",
        recipient: "张三",
        status: "sent",
        original_payload: {
          draft: {
            ...actionDraft,
            title: "Rotate API Key sk-test123456789",
            evidence: "Authorization: Bearer sk-test123456789 should not appear.",
            suggested_reason: ".env includes OPENAI_API_KEY=sk-test123456789."
          },
          meeting_id: "mtg_secret"
        }
      })
    );
    const serialized = JSON.stringify(card);

    expect(serialized).not.toContain("API Key");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("sk-test123456789");
    expect(serialized).toContain("[REDACTED]");
  });

  it("falls back to a generic card for future confirmation types", () => {
    const card = expectValidCard(
      buildGenericConfirmationCard({
        id: "conf_generic",
        request_type: "archive_source",
        target_id: "src_001",
        recipient: null,
        status: "sent",
        original_payload: {
          source_id: "src_001"
        }
      })
    );

    expect(card.card_type).toBe("generic_confirmation");
    expect(card.title).toBe("确认请求：archive_source");
    expect(card.editable_fields).toEqual([]);
  });

  it("builds the right card type from a stored confirmation request", () => {
    const request: ConfirmationRequestRow = {
      id: "conf_from_row",
      request_type: "action",
      target_id: "act_from_row",
      recipient: "张三",
      card_message_id: null,
      status: "sent",
      original_payload_json: JSON.stringify({
        draft: actionDraft,
        meeting_id: "mtg_001"
      }),
      edited_payload_json: null,
      confirmed_at: null,
      executed_at: null,
      error: null,
      created_at: "2026-04-29T10:00:00.000Z",
      updated_at: "2026-04-29T10:00:00.000Z"
    };

    const card = expectValidCard(buildConfirmationCardFromRequest(request));

    expect(card.card_type).toBe("action_confirmation");
    expect(card.request_id).toBe("conf_from_row");
  });

  it("adds execution result links from store rows to stored confirmation cards", () => {
    const repos = createRepositories(createMemoryDatabase());
    repos.createMeeting({
      id: "mtg_result_link",
      external_meeting_id: null,
      title: "客户访谈复盘",
      started_at: "2026-05-01T09:00:00+08:00",
      ended_at: "2026-05-01T10:00:00+08:00",
      organizer: "ou_owner",
      participants_json: JSON.stringify(["ou_owner"]),
      minutes_url: null,
      transcript_url: null,
      transcript_text: "会议确认客户访谈资料需要沉淀并跟进。",
      summary: "客户访谈资料沉淀。",
      keywords_json: JSON.stringify(["客户访谈"]),
      matched_kb_id: null,
      match_score: null,
      archive_status: "archived",
      action_count: 1,
      calendar_count: 1
    });
    repos.createActionItem({
      id: "act_result_link",
      meeting_id: "mtg_result_link",
      kb_id: null,
      title: actionDraft.title,
      description: actionDraft.description,
      owner: actionDraft.owner,
      collaborators_json: JSON.stringify(actionDraft.collaborators),
      due_date: actionDraft.due_date,
      priority: actionDraft.priority,
      evidence: actionDraft.evidence,
      confidence: actionDraft.confidence,
      suggested_reason: actionDraft.suggested_reason,
      missing_fields_json: JSON.stringify(actionDraft.missing_fields),
      confirmation_status: "created",
      feishu_task_guid: "dry_task_act_result_link",
      task_url: "mock://feishu/task/act_result_link",
      rejection_reason: null
    });
    repos.createCalendarDraft({
      id: "cal_result_link",
      meeting_id: "mtg_result_link",
      kb_id: null,
      title: calendarDraft.title,
      start_time: calendarDraft.start_time,
      end_time: calendarDraft.end_time,
      duration_minutes: calendarDraft.duration_minutes,
      participants_json: JSON.stringify(calendarDraft.participants),
      agenda: calendarDraft.agenda,
      location: calendarDraft.location,
      evidence: calendarDraft.evidence,
      confidence: calendarDraft.confidence,
      missing_fields_json: JSON.stringify(calendarDraft.missing_fields),
      confirmation_status: "created",
      calendar_event_id: "dry_event_cal_result_link",
      event_url: "mock://feishu/calendar/cal_result_link"
    });
    repos.createKnowledgeBase({
      id: "kb_result_link",
      name: "客户访谈知识库",
      goal: "沉淀客户访谈结论。",
      description: "客户访谈资料沉淀。",
      owner: "ou_owner",
      status: "active",
      confidence_origin: 0.86,
      wiki_url: "mock://feishu/wiki/kb_result_link",
      homepage_url: "mock://feishu/wiki/kb_result_link/00-home",
      related_keywords_json: JSON.stringify(["客户访谈"]),
      created_from_meetings_json: JSON.stringify(["mtg_result_link"]),
      auto_append_policy: "ask_every_time"
    });

    const baseRequest = {
      recipient: "ou_owner",
      card_message_id: null,
      status: "executed" as const,
      confirmed_at: null,
      executed_at: "2026-05-01T10:00:00.000Z",
      error: null,
      created_at: "2026-05-01T09:00:00.000Z",
      updated_at: "2026-05-01T10:00:00.000Z"
    };

    const actionCard = expectValidCard(
      buildConfirmationCardFromRequest(
        {
          ...baseRequest,
          id: "conf_action_result_link",
          request_type: "action",
          target_id: "act_result_link",
          original_payload_json: JSON.stringify({ draft: actionDraft }),
          edited_payload_json: null
        },
        { repos }
      )
    );
    const calendarCard = expectValidCard(
      buildConfirmationCardFromRequest(
        {
          ...baseRequest,
          id: "conf_calendar_result_link",
          request_type: "calendar",
          target_id: "cal_result_link",
          original_payload_json: JSON.stringify({ draft: calendarDraft }),
          edited_payload_json: null
        },
        { repos }
      )
    );
    const createKbCard = expectValidCard(
      buildConfirmationCardFromRequest(
        {
          ...baseRequest,
          id: "conf_kb_result_link",
          request_type: "create_kb",
          target_id: "kb_candidate_result_link",
          original_payload_json: JSON.stringify({
            topic_name: "客户访谈知识库",
            suggested_goal: "沉淀客户访谈结论。",
            candidate_meeting_ids: ["mtg_result_link"],
            reason: "检测到相关会议，建议创建主题知识库。"
          }),
          edited_payload_json: JSON.stringify({
            result_links: {
              knowledge_base_id: "kb_result_link"
            }
          })
        },
        { repos }
      )
    );

    const actionFields = actionCard.sections.flatMap((section) => section.fields);
    const calendarFields = calendarCard.sections.flatMap((section) => section.fields);
    const createKbFields = createKbCard.sections.flatMap((section) => section.fields);

    expect(actionFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "task_url",
          label: "飞书任务",
          value: "mock://feishu/task/act_result_link"
        })
      ])
    );
    expect(calendarFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "event_url",
          label: "飞书日程",
          value: "mock://feishu/calendar/cal_result_link"
        })
      ])
    );
    expect(createKbFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "wiki_url",
          label: "知识库",
          value: "mock://feishu/wiki/kb_result_link"
        }),
        expect.objectContaining({
          key: "homepage_url",
          label: "首页",
          value: "mock://feishu/wiki/kb_result_link/00-home"
        })
      ])
    );
  });
});
