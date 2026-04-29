import {
  buildActionConfirmationCard,
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
      dry_run: true
    });
    expect(card.editable_fields.map((field) => field.key)).toEqual([
      "title",
      "owner",
      "due_date",
      "priority",
      "collaborators"
    ]);
    expect(card.sections.flatMap((section) => section.fields.map((field) => field.key))).toEqual(
      expect.arrayContaining([
        "title",
        "recommended_owner",
        "suggested_reason",
        "due_date",
        "priority",
        "confidence",
        "evidence",
        "missing_fields",
        "meeting_id"
      ])
    );
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
    expect(card.sections.flatMap((section) => section.fields.map((field) => field.key))).toEqual(
      expect.arrayContaining([
        "title",
        "start_time",
        "end_time",
        "duration_minutes",
        "participants",
        "location",
        "agenda",
        "evidence",
        "confidence",
        "missing_fields"
      ])
    );
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
          match_reasons: ["会议摘要/转写围绕相同主题信号"],
          score: 0.92,
          default_structure: ["00 首页 / 总览", "06 单个会议总结"],
          reason: "检测到至少两场强相关会议，建议创建主题知识库。"
        }
      })
    );

    expect(card.card_type).toBe("create_kb_confirmation");
    expect(card.summary).toContain("会议数：2");
    expect(card.sections.flatMap((section) => section.fields.map((field) => field.key))).toEqual(
      expect.arrayContaining([
        "topic_name",
        "suggested_goal",
        "score",
        "match_reasons",
        "candidate_meeting_ids",
        "default_structure",
        "safety_note"
      ])
    );
    expect(
      card.sections
        .flatMap((section) => section.fields)
        .find((field) => field.key === "safety_note")?.value
    ).toBe("用户确认前不会创建知识库");
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
