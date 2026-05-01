import {
  buildActionConfirmationCard,
  buildAppendMeetingConfirmationCard,
  buildCalendarConfirmationCard,
  buildConfirmationCardFromRequest,
  buildCreateKbConfirmationCard,
  buildGenericConfirmationCard
} from "../../src/agents/cardInteractionAgent";
import { DryRunConfirmationCardSchema } from "../../src/schemas";
import { ConfirmationRequestRow } from "../../src/services/store/repositories";

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
      title: "确认待办：整理无人机操作流程",
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
      "evidence"
    ]);
    expect(JSON.stringify(card)).not.toContain("confidence");
    expect(JSON.stringify(card)).not.toContain("missing_fields");
    expect(JSON.stringify(card)).not.toContain("meeting_id");
    expect(card.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject",
      "not_mine",
      "remind_later"
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
        recipient: "Henry",
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
    expect(card.summary).toContain("建议负责人：待确认");
    expect(
      card.sections[0]?.fields.find((field) => field.key === "recommended_owner")
    ).toMatchObject({
      label: "建议负责人",
      value: "待确认"
    });
    expect(visibleText).not.toContain("Henry");
    expect(visibleText).not.toContain("认领");
    expect(visibleText).not.toContain("承诺");
    expect(card.actions.map((action) => action.key)).toEqual([
      "complete_owner",
      "reject",
      "not_mine",
      "remind_later"
    ]);
    expect(card.status_text).toBe("缺少负责人，需先补全后再添加待办");
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
    expect(card.title).toBe("确认日程：无人机操作员访谈会议");
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
      "evidence"
    ]);
    expect(JSON.stringify(card)).not.toContain("confidence");
    expect(JSON.stringify(card)).not.toContain("missing_fields");
    expect(JSON.stringify(card)).not.toContain("meeting_id");
    expect(card.editable_fields.map((field) => field.key)).toEqual([
      "title",
      "start_time",
      "end_time",
      "duration_minutes",
      "participants",
      "location",
      "agenda"
    ]);
    expect(card.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject",
      "convert_to_task",
      "remind_later"
    ]);
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
});
