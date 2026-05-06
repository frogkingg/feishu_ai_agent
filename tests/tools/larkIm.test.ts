import {
  buildActionConfirmationCard,
  buildCalendarConfirmationCard,
  buildCreateKbConfirmationCard
} from "../../src/agents/cardInteractionAgent";
import { loadConfig } from "../../src/config";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { type LarkCliRunner } from "../../src/tools/larkCli";
import {
  buildFeishuInteractiveCard,
  sendCard,
  syncConfirmationCardStatus
} from "../../src/tools/larkIm";

const card = buildActionConfirmationCard({
  id: "conf_card_send",
  target_id: "act_card_send",
  recipient: "ou_recipient",
  status: "sent",
  original_payload: {
    draft: {
      title: "整理无人机操作流程",
      description: "把现有操作步骤整理成清单。",
      owner: "张三",
      collaborators: [],
      due_date: "2026-05-01",
      priority: "P1",
      evidence: "张三：我可以整理现有操作流程。",
      confidence: 0.91,
      suggested_reason: "会议中明确了负责人。",
      missing_fields: []
    },
    meeting_reference: "无人机操作方案初访（会议纪要：https://example.feishu.cn/minutes/min_001）"
  }
});

describe("larkIm.sendCard", () => {
  const failingRunner: LarkCliRunner = async () => {
    throw new Error("fake lark CLI failure");
  };
  const validCardCallbackConfig = {
    feishuCardActionsEnabled: true,
    larkVerificationToken: "verification-token",
    larkEncryptKey: "encrypt-key",
    larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action"
  };

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

  it("builds a real send-state confirmation card with callback buttons by default", () => {
    const interactive = buildFeishuInteractiveCard(card);
    const serialized = JSON.stringify(interactive);

    expect(interactive.config).toMatchObject({
      wide_screen_mode: true,
      update_multi: true
    });
    expect(interactive.header.title.content).toBe("📌 整理无人机操作流程");
    expect(interactive.header.template).toBe("turquoise");
    expect(serialized).not.toContain(`待办 | ${card.summary}`);
    expect(serialized).not.toContain("待办确认");
    expect(serialized).toContain("建议");
    expect(serialized).toContain("依据");
    expect(serialized).toContain("建议原因");
    expect(serialized).not.toContain("置信度");
    expect(serialized).toContain("[会议纪要](https://example.feishu.cn/minutes/min_001)");
    expect(serialized).not.toContain("/dev/confirmations/conf_card_send/confirm");
    expect(serialized).toContain('"action":"confirm"');
    expect(serialized).not.toContain('"action":"confirm_with_edits"');
    expect(card.actions.map((action) => action.key)).toEqual(["confirm", "confirm_with_edits", "reject"]);
    expect(serialized).not.toContain('"action":"not_mine"');
    expect(serialized).not.toContain('"action":"remind_later"');
    expect(serialized).not.toContain("mtg_001");
    expect(serialized).toContain('"confirmation_id":"conf_card_send"');
    expect(serialized).not.toContain("安全说明");
    expect(serialized).not.toContain("可修改信息");
    expect(serialized).not.toContain('"name":"owner"');
    expect(serialized).not.toContain('"name":"due_date"');
    expect(serialized).not.toContain('"tag":"textarea"');
    expect(serialized).not.toContain("可在飞书「任务」中补齐负责人/截止时间后直接添加。");
    const actionElement = interactive.elements.find((element) => element.tag === "action");
    expect(actionElement).toMatchObject({
      actions: [
        { text: { content: "添加待办" } },
        { text: { content: "不添加" } }
      ]
    });
  });

  it("filters legacy low-priority actions from real interactive cards", () => {
    const legacyCard = {
      ...card,
      actions: [
        ...card.actions,
        {
          key: "not_mine",
          label: "不是我的",
          style: "default",
          action_type: "http_post",
          endpoint: "/dev/confirmations/conf_card_send/reject",
          payload_template: { reason: "not_mine" }
        },
        {
          key: "remind_later",
          label: "稍后处理",
          style: "default",
          action_type: "http_post",
          endpoint: "/dev/confirmations/conf_card_send/remind-later",
          payload_template: { reminder: "$remind_later" }
        }
      ]
    } satisfies typeof card;

    const interactive = buildFeishuInteractiveCard(legacyCard);
    const serialized = JSON.stringify(interactive);

    expect(serialized).toContain('"action":"confirm"');
    expect(serialized).toContain('"action":"reject"');
    expect(serialized).not.toContain('"action":"not_mine"');
    expect(serialized).not.toContain('"action":"remind_later"');
    expect(interactive.elements.find((element) => element.tag === "action")).toMatchObject({
      actions: [{ text: { content: "添加待办" } }, { text: { content: "不添加" } }]
    });
  });

  it("renders missing-owner action cards as personal todo creation", () => {
    const missingOwnerCard = buildActionConfirmationCard({
      id: "conf_missing_owner",
      target_id: "act_missing_owner",
      recipient: "ou_recipient",
      status: "sent",
      original_payload: {
        draft: {
          title: "整理客户访谈结论",
          description: "汇总访谈输出。",
          owner: null,
          collaborators: [],
          due_date: "2026-05-03",
          priority: "P1",
          evidence: "会议中提出需要整理客户访谈结论，但没有明确负责人。",
          confidence: 0.82,
          suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。",
          missing_fields: ["owner"]
        }
      }
    });

    const interactive = buildFeishuInteractiveCard(missingOwnerCard);
    const serialized = JSON.stringify(interactive);
    const actionElement = interactive.elements.find((element) => element.tag === "action");

    expect(serialized).toContain("负责人待补充");
    expect(serialized).toContain('"name":"owner"');
    expect(serialized).not.toContain('"tag":"select_person"');
    expect(serialized).not.toContain("补全负责人");
    expect(serialized).not.toContain("我的个人待办");
    expect(serialized).not.toContain('"action":"complete_owner"');
    expect(serialized).toContain('"action":"confirm"');
    expect(serialized).not.toContain('"action":"confirm_with_edits"');
    expect(missingOwnerCard.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject"
    ]);
    expect(serialized).not.toContain('"action":"not_mine"');
    expect(serialized).not.toContain('"action":"remind_later"');
    expect(serialized).not.toContain("可在飞书「任务」中补齐负责人/截止时间后直接添加。");
    expect(actionElement).toMatchObject({
      actions: [
        { text: { content: "添加待办" } },
        { text: { content: "不添加" } }
      ]
    });
  });

  it("keeps edited missing-owner cards out of person selection", () => {
    const completionCard = buildActionConfirmationCard({
      id: "conf_personal_todo",
      target_id: "act_personal_todo",
      recipient: "ou_recipient",
      status: "edited",
      original_payload: {
        draft: {
          title: "整理客户访谈结论",
          description: "汇总访谈输出。",
          owner: null,
          collaborators: [],
          due_date: "2026-05-03",
          priority: "P1",
          evidence: "会议中提出需要整理客户访谈结论，但没有明确负责人。",
          confidence: 0.82,
          suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。",
          missing_fields: ["owner"]
        }
      }
    });

    const interactive = buildFeishuInteractiveCard(completionCard);
    const serialized = JSON.stringify(interactive);
    const actionElement = interactive.elements.find((element) => element.tag === "action");

    expect(serialized).toContain("负责人待补充");
    expect(serialized).not.toContain("我的个人待办");
    expect(serialized).not.toContain('"tag":"select_person"');
    expect(serialized).toContain('"name":"owner"');
    expect(serialized).not.toContain("补全负责人");
    expect(serialized).not.toContain("@确认待办");
    expect(serialized).toContain('"action":"confirm"');
    expect(serialized).not.toContain('"action":"confirm_with_edits"');
    expect(completionCard.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject"
    ]);
    expect(serialized).not.toContain('"action":"not_mine"');
    expect(serialized).not.toContain('"action":"remind_later"');
    expect(serialized).not.toContain('"action":"complete_owner"');
    expect(serialized).not.toContain("可在飞书「任务」中补齐负责人/截止时间后直接添加。");
    expect(actionElement).toMatchObject({
      actions: [
        { text: { content: "添加待办" } },
        { text: { content: "不添加" } }
      ]
    });
  });

  it("renders calendar cards with calendar color and focused actions", () => {
    const calendarCard = buildCalendarConfirmationCard({
      id: "conf_calendar_send",
      target_id: "cal_card_send",
      recipient: "ou_recipient",
      status: "sent",
      original_payload: {
        draft: {
          title: "无人机操作员访谈会议",
          start_time: "2026-05-05T10:00:00+08:00",
          end_time: null,
          duration_minutes: 60,
          participants: ["张三", "王五"],
          agenda: "确认真实操作步骤和限制。",
          location: "会议室 A",
          evidence: "下周二上午 10 点我们再约操作员访谈。",
          confidence: 0.84,
          missing_fields: []
        },
        meeting_reference:
          "无人机操作员访谈（转写记录：https://example.feishu.cn/minutes/transcript_001）"
      }
    });

    const interactive = buildFeishuInteractiveCard(calendarCard);
    const serialized = JSON.stringify(interactive);
    const visibleText = JSON.stringify(interactive.elements.slice(0, 6));

    expect(interactive.header.template).toBe("orange");
    expect(interactive.header.title.content).toBe("📅 无人机操作员访谈会议");
    expect(serialized).not.toContain("日程 | 开始：5月5日 10:00");
    expect(visibleText).not.toContain("2026-05-05T10:00:00+08:00");
    expect(serialized).toContain("建议");
    expect(serialized).toContain("依据");
    expect(serialized).toContain("[转写记录](https://example.feishu.cn/minutes/transcript_001)");
    expect(serialized).toContain("开始时间");
    expect(serialized).toContain("参会人");
    expect(serialized).toContain("原文片段");
    expect(serialized).not.toContain("置信度");
    expect(serialized).not.toContain('"name":"agenda"');
    expect(serialized).not.toContain("安全说明");
    expect(serialized).not.toContain("可修改信息");
    expect(serialized).not.toContain('"tag":"textarea"');
    expect(serialized).toContain('"action":"confirm"');
    expect(serialized).not.toContain('"action":"confirm_with_edits"');
    expect(serialized).toContain('"action":"convert_to_task"');
    expect(calendarCard.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject",
      "convert_to_task"
    ]);
    expect(serialized).not.toContain('"action":"remind_later"');
    expect(serialized).not.toContain('"action":"not_mine"');
    expect(serialized).not.toContain("可在飞书「日历」中补齐时间/参会人后直接创建。");
    expect(serialized).not.toContain("mtg_001");
    expect(interactive.elements.find((element) => element.tag === "action")).toMatchObject({
      actions: [
        { text: { content: "添加日程" } },
        { text: { content: "转待办" } },
        { text: { content: "不添加" } }
      ]
    });
  });

  it("allows adding calendar cards when start time is present even if location is missing", () => {
    const calendarCard = buildCalendarConfirmationCard({
      id: "conf_calendar_missing_location",
      target_id: "cal_card_missing_location",
      recipient: "ou_recipient",
      status: "sent",
      original_payload: {
        draft: {
          title: "无人机操作员访谈会议",
          start_time: "2026-05-05T10:00:00+08:00",
          end_time: null,
          duration_minutes: 60,
          participants: ["张三"],
          agenda: "确认真实操作步骤和限制。",
          location: null,
          evidence: "下周二上午 10 点我们再约操作员访谈。",
          confidence: 0.7,
          missing_fields: ["location"]
        }
      }
    });

    const interactive = buildFeishuInteractiveCard(calendarCard);
    const serialized = JSON.stringify(interactive);

    expect(serialized).not.toContain("需补充");
    const actionElement = interactive.elements.find((element) => element.tag === "action");
    expect(actionElement).toMatchObject({
      actions: [
        { text: { content: "添加日程" } },
        { text: { content: "转待办" } },
        { text: { content: "不添加" } }
      ]
    });
    expect(serialized).not.toContain("可在飞书「日历」中补齐时间/参会人后直接创建。");
  });

  it("keeps only missing start time input on calendar cards", () => {
    const calendarCard = buildCalendarConfirmationCard({
      id: "conf_calendar_missing",
      target_id: "cal_card_missing",
      recipient: "ou_recipient",
      status: "sent",
      original_payload: {
        draft: {
          title: "无人机操作员访谈会议",
          start_time: null,
          end_time: null,
          duration_minutes: null,
          participants: ["张三"],
          agenda: "确认真实操作步骤和限制。",
          location: null,
          evidence: "下次再约操作员访谈。",
          confidence: 0.7,
          missing_fields: ["start_time", "duration_minutes", "location"]
        }
      }
    });

    const interactive = buildFeishuInteractiveCard(calendarCard);
    const serialized = JSON.stringify(interactive);

    expect(serialized).not.toContain("需补充");
    expect(serialized).toContain('"name":"start_time"');
    expect(serialized).not.toContain('"name":"duration_minutes"');
    expect(serialized).not.toContain('"name":"location"');
    expect(serialized).not.toContain('"name":"agenda"');
    expect(serialized).not.toContain("可修改信息");
    const actionElement = interactive.elements.find((element) => element.tag === "action");
    expect(actionElement).toMatchObject({
      actions: [
        { text: { content: "添加日程" } },
        { text: { content: "转待办" } },
        { text: { content: "不添加" } }
      ]
    });
    expect(serialized).not.toContain("可在飞书「日历」中补齐时间/参会人后直接创建。");
  });

  it("renders knowledge-base cards with knowledge color and fewer actions", () => {
    const kbCard = buildCreateKbConfirmationCard({
      id: "conf_kb_send",
      target_id: "kb_card_send",
      recipient: "ou_recipient",
      status: "sent",
      original_payload: {
        topic_name: "无人机操作方案",
        suggested_goal: "沉淀无人机操作方案相关会议结论。",
        meeting_ids: ["mtg_001", "mtg_002"],
        match_reasons: ["会议摘要/转写围绕相同主题信号"],
        candidate_meeting_refs: [
          "无人机操作方案初访（会议纪要：https://example.feishu.cn/minutes/min_001）",
          "无人机操作员访谈（转写记录：https://example.feishu.cn/minutes/transcript_002）"
        ],
        score: 0.92,
        default_structure: ["00 首页 / 总览", "06 单个会议总结"],
        reason:
          "检测到至少两场强相关会议，建议创建主题知识库，并将访谈摘要、关键结论、风险和后续行动统一沉淀到一个可持续维护的空间，避免团队后续继续在群聊里翻找零散信息。"
      }
    });

    const interactive = buildFeishuInteractiveCard(kbCard);
    const serialized = JSON.stringify(interactive);

    expect(interactive.header.template).toBe("green");
    expect(interactive.header.title.content).toBe("📚 无人机操作方案");
    expect(serialized).not.toContain("知识库 | 主题：无人机操作方案");
    expect(serialized).toContain("...");
    expect(serialized).not.toContain("避免团队后续继续在群聊里翻找零散信息。");
    expect(serialized).toContain("建议");
    expect(serialized).toContain("主题名称");
    expect(serialized).toContain("会议");
    expect(serialized).toContain("[会议纪要](https://example.feishu.cn/minutes/min_001)");
    expect(serialized).toContain("[转写记录](https://example.feishu.cn/minutes/transcript_002)");
    expect(serialized).not.toContain('"name":"suggested_goal"');
    expect(serialized).not.toContain("安全说明");
    expect(serialized).not.toContain("可修改信息");
    expect(serialized).not.toContain('"tag":"textarea"');
    expect(serialized).toContain('"action":"create_kb"');
    expect(serialized).not.toContain('"action":"edit_and_create"');
    expect(serialized).toContain('"action":"append_current_only"');
    expect(serialized).toContain('"action":"never_remind_topic"');
    expect(serialized).not.toContain("匹配分");
    expect(serialized).not.toContain("match_reasons");
    expect(serialized).not.toContain("确认后可在知识库中创建/整理，本卡片先展示建议。");
    expect(interactive.elements.find((element) => element.tag === "action")).toMatchObject({
      actions: [
        { text: { content: "创建知识库" } },
        { text: { content: "仅归档本次" } },
        { text: { content: "不再提醒" } },
        { text: { content: "不创建" } }
      ]
    });
  });

  it("renders dry-run button labels with preview wording", () => {
    const interactive = buildFeishuInteractiveCard(card, { mode: "dry_run" });

    expect(interactive.elements.find((element) => element.tag === "action")).toMatchObject({
      actions: [
        { text: { content: "预览添加待办" } },
        { text: { content: "不添加" } }
      ]
    });
  });

  it("renders preview-only display cards only when actions are explicitly disabled", () => {
    const interactive = buildFeishuInteractiveCard(card, { actionsEnabled: false });
    const serialized = JSON.stringify(interactive);
    const actionElement = interactive.elements.find((element) => element.tag === "action");

    expect(serialized).not.toContain('"action":"confirm"');
    expect(serialized).not.toContain('"behaviors"');
    expect(serialized).toContain("可在飞书「任务」中补齐负责人/截止时间后直接添加。");
    expect(actionElement).toBeUndefined();
  });

  it("keeps missing-field action cards simple when actions are enabled", () => {
    const missingOwnerCard = buildActionConfirmationCard({
      id: "conf_missing_owner_enabled",
      target_id: "act_missing_owner_enabled",
      recipient: "ou_recipient",
      status: "sent",
      original_payload: {
        draft: {
          title: "整理客户访谈结论",
          description: "汇总访谈输出。",
          owner: null,
          collaborators: [],
          due_date: null,
          priority: "P1",
          evidence: "会议中提出需要整理客户访谈结论，但没有明确负责人。",
          confidence: 0.82,
          suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。",
          missing_fields: ["owner", "due_date"]
        }
      }
    });
    const interactive = buildFeishuInteractiveCard(missingOwnerCard, { actionsEnabled: true });
    const serialized = JSON.stringify(interactive);

    expect(serialized).toContain('"name":"owner"');
    expect(serialized).toContain('"name":"due_date"');
    expect(serialized).toContain('"action":"confirm"');
    expect(serialized).not.toContain('"action":"confirm_with_edits"');
    expect(serialized).not.toContain("补全后添加待办");
    expect(interactive.elements.find((element) => element.tag === "action")).toMatchObject({
      actions: [
        {
          text: { content: "添加待办" },
          value: {
            action_key: "confirm",
            action: "confirm",
            confirmation_id: "conf_missing_owner_enabled",
            request_id: "conf_missing_owner_enabled"
          }
        },
        { text: { content: "不添加" } }
      ]
    });
  });

  it("renders terminal and failed card statuses without repeat-confirm buttons", () => {
    const executed = buildFeishuInteractiveCard(
      buildActionConfirmationCard({
        id: "conf_executed_action",
        target_id: "act_executed",
        recipient: "ou_recipient",
        status: "executed",
        original_payload: card
      })
    );
    expect(JSON.stringify(executed)).toContain("已添加待办");
    expect(executed.header.template).toBe("green");
    const executedJson = JSON.stringify(executed);
    expect(executed.elements.find((element) => element.tag === "action")).toBeUndefined();
    expect(executedJson).not.toContain("disabled");
    expect(executedJson).not.toContain('"action":"confirm"');
    expect(executedJson).not.toContain("behaviors");

    const rejected = buildFeishuInteractiveCard(
      buildCalendarConfirmationCard({
        id: "conf_rejected_calendar",
        target_id: "cal_rejected",
        recipient: "ou_recipient",
        status: "rejected",
        original_payload: {
          draft: {
            title: "客户访谈复盘",
            start_time: "2026-05-05T10:00:00+08:00",
            end_time: null,
            duration_minutes: 60,
            participants: ["张三"],
            agenda: "复盘访谈结论。",
            location: null,
            evidence: "周二 10 点复盘。",
            confidence: 0.8,
            missing_fields: []
          }
        }
      })
    );
    expect(JSON.stringify(rejected)).toContain("已不添加");
    expect(rejected.header.template).toBe("grey");
    const rejectedJson = JSON.stringify(rejected);
    expect(rejected.elements.find((element) => element.tag === "action")).toBeUndefined();
    expect(rejectedJson).not.toContain("disabled");
    expect(rejectedJson).not.toContain('"action":"confirm"');
    expect(rejectedJson).not.toContain("behaviors");

    const processing = buildFeishuInteractiveCard(
      buildCreateKbConfirmationCard({
        id: "conf_processing_kb",
        target_id: "kb_processing",
        recipient: "ou_recipient",
        status: "confirmed",
        original_payload: {
          topic_name: "客户访谈沉淀",
          meeting_ids: ["mtg_001"],
          default_structure: ["00 总览"]
        }
      })
    );
    const processingJson = JSON.stringify(processing);
    expect(processingJson).toContain("正在添加到飞书...");
    expect(processing.elements.find((element) => element.tag === "action")).toBeUndefined();
    expect(processingJson).not.toContain("disabled");

    const failed = buildFeishuInteractiveCard(
      buildActionConfirmationCard({
        id: "conf_failed_action",
        target_id: "act_failed",
        recipient: "ou_recipient",
        status: "failed",
        error: "lark.task.create failed: fake task error with a very clear cause",
        original_payload: {
          draft: {
            title: "整理客户访谈结论",
            description: "汇总访谈输出。",
            owner: "张三",
            collaborators: [],
            due_date: "2026-05-01",
            priority: "P1",
            evidence: "张三负责整理。",
            confidence: 0.91,
            suggested_reason: "会议明确了负责人。",
            missing_fields: []
          }
        }
      })
    );
    const failedJson = JSON.stringify(failed);
    expect(failed.header.template).toBe("red");
    expect(failedJson).toContain("添加失败");
    expect(failedJson).toContain("fake task error");
    expect(failed.elements.find((element) => element.tag === "action")).toBeUndefined();
    expect(failedJson).not.toContain("disabled");
    expect(failedJson).not.toContain('"action":"confirm"');
    expect(failedJson).not.toContain("behaviors");
  });

  it("falls back from card-action token update to message PATCH with terminal card content", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "POST") {
        throw new Error("card action token expired");
      }
      if (args[0] === "api" && args[1] === "PATCH") {
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const confirmation = repos.createConfirmationRequest({
      id: "conf_sync_status",
      request_type: "action",
      target_id: "act_sync_status",
      recipient: "ou_recipient",
      card_message_id: "om_existing_card",
      status: "executed",
      original_payload_json: JSON.stringify({}),
      edited_payload_json: null,
      confirmed_at: null,
      executed_at: null,
      error: null
    });
    const finalCard = {
      ...card,
      status: "executed" as const,
      status_text: "已添加待办",
      actions: []
    };

    const result = await syncConfirmationCardStatus({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        feishuCardSendDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      confirmation,
      card: finalCard,
      updateToken: "card_action_token",
      messageId: "om_existing_card",
      chatId: "oc_card_chat",
      runner
    });

    expect(result).toMatchObject({
      ok: true,
      method: "update",
      status: "updated",
      card_message_id: "om_existing_card"
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["api", "POST", "/open-apis/interactive/v1/card/update", "--data"])
    );
    const tokenData = JSON.parse(dataArg(calls[0])) as { token: string; card: { config: unknown } };
    expect(tokenData.token).toBe("card_action_token");
    expect(tokenData.card.config).toMatchObject({ update_multi: true });

    expect(calls[1]).toEqual(
      expect.arrayContaining(["api", "PATCH", "/open-apis/im/v1/messages/om_existing_card"])
    );
    expect(calls[1]).not.toContain("--params");
    const patchData = JSON.parse(dataArg(calls[1])) as { content: string };
    const patchedCard = JSON.parse(patchData.content) as { elements: Array<{ tag: string }> };
    expect(JSON.stringify(patchedCard)).toContain("已添加待办");
    expect(JSON.stringify(patchedCard)).not.toContain("disabled");
    expect(patchedCard.elements.some((element) => element.tag === "action")).toBe(false);
    expect(repos.listCliRuns().map((run) => run.status)).toEqual(["failed", "success"]);
  });

  it("records planned send-card cli_runs when both dry-run switches are true", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuCardSendDryRun: true,
        larkCliBin: "definitely-not-real-lark"
      }),
      card,
      recipient: "ou_test_user"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "planned",
      dry_run: true,
      card_message_id: null,
      recipient: "ou_test_user"
    });
    const runs = repos.listCliRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      tool: "lark.im.send_card",
      dry_run: 1,
      status: "planned"
    });
    const args = JSON.parse(runs[0].args_json) as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "im",
        "+messages-send",
        "--user-id",
        "ou_test_user",
        "--msg-type",
        "interactive"
      ])
    );
    expect(contentArg(args)).toContain("整理无人机操作流程");
    expect(contentArg(args)).toContain("预览添加待办");
    expect(contentArg(args)).not.toMatch(/^@/);
    expect(args).not.toContain("--dry-run");
  });

  it("fails in real mode when the fake CLI runner fails", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        feishuCardSendDryRun: false,
        ...validCardCallbackConfig,
        larkCliBin: "definitely-not-real-lark"
      }),
      card,
      chatId: "oc_test_chat",
      runner: failingRunner
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      dry_run: false,
      card_message_id: null,
      chat_id: "oc_test_chat"
    });
    expect(result.error).toContain("lark.im.send_card failed");
    const runs = repos.listCliRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      tool: "lark.im.send_card",
      dry_run: 0,
      status: "failed"
    });
  });

  it("uses the real send path when only card send dry-run is disabled", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: LarkCliRunner = async (bin, args) => {
      calls.push({ bin, args });
      const cardJson = contentArg(args);
      expect(cardJson).toContain("整理无人机操作流程");
      expect(cardJson).toContain("张三");
      return {
        stdout: JSON.stringify({ message_id: "om_fake_card_message" }),
        stderr: ""
      };
    };

    const result = await sendCard({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuCardSendDryRun: false,
        ...validCardCallbackConfig,
        larkCliBin: "fake-lark-cli"
      }),
      card,
      chatId: "oc_test_chat",
      runner
    });

    expect(result).toMatchObject({
      ok: true,
      status: "sent",
      dry_run: false,
      card_message_id: "om_fake_card_message",
      chat_id: "oc_test_chat"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ bin: "fake-lark-cli" });
    expect(calls[0].args).toEqual(
      expect.arrayContaining([
        "im",
        "+messages-send",
        "--chat-id",
        "oc_test_chat",
        "--msg-type",
        "interactive",
        "--content"
      ])
    );
    expect(contentArg(calls[0].args)).not.toMatch(/^@/);
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.im.send_card",
      dry_run: 0,
      status: "success"
    });
  });

  it("fails real send-state cards when explicitly configured as preview-only", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuCardSendDryRun: false,
        feishuCardActionsEnabled: false,
        larkVerificationToken: "verification-token",
        larkEncryptKey: "encrypt-key",
        larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action",
        larkCliBin: "definitely-not-real-lark"
      }),
      card,
      chatId: "oc_test_chat"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      dry_run: false,
      cli_run_id: null,
      card_message_id: null,
      chat_id: "oc_test_chat"
    });
    expect(result.error).toContain("require clickable card-action callbacks");
    expect(result.error).toContain("FEISHU_CARD_ACTIONS_ENABLED must be true");
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it.each([
    [
      "missing callback URL",
      {
        feishuCardActionsEnabled: true,
        larkVerificationToken: "verification-token",
        larkEncryptKey: "encrypt-key",
        larkCardCallbackUrlHint: null
      },
      "LARK_CARD_CALLBACK_URL_HINT must be configured"
    ],
    [
      "localhost callback URL",
      {
        feishuCardActionsEnabled: true,
        larkVerificationToken: "verification-token",
        larkEncryptKey: "encrypt-key",
        larkCardCallbackUrlHint: "http://localhost:3000/webhooks/feishu/card-action"
      },
      "must be an http/https public URL"
    ],
    [
      "missing verification token",
      {
        feishuCardActionsEnabled: true,
        larkVerificationToken: null,
        larkEncryptKey: "encrypt-key",
        larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card-action"
      },
      "LARK_VERIFICATION_TOKEN must be configured"
    ],
    [
      "wrong callback path",
      {
        feishuCardActionsEnabled: true,
        larkVerificationToken: "verification-token",
        larkEncryptKey: "encrypt-key",
        larkCardCallbackUrlHint: "https://meetingatlas.example.com/webhooks/feishu/card"
      },
      "should end with /webhooks/feishu/card-action"
    ]
  ])(
    "fails real send-state cards when callback readiness is invalid: %s",
    async (_name, configPatch, error) => {
      const repos = createRepositories(createMemoryDatabase());
      const calls: string[][] = [];
      const runner: LarkCliRunner = async (_bin, args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ message_id: "om_should_not_send" }), stderr: "" };
      };

      const result = await sendCard({
        repos,
        config: loadConfig({
          feishuDryRun: true,
          feishuCardSendDryRun: false,
          ...configPatch,
          larkCliBin: "fake-lark-cli"
        }),
        card,
        chatId: "oc_test_chat",
        runner
      });

      expect(result).toMatchObject({
        ok: false,
        status: "failed",
        dry_run: false,
        cli_run_id: null,
        card_message_id: null
      });
      expect(result.error).toContain(error);
      expect(calls).toHaveLength(0);
      expect(repos.listCliRuns()).toHaveLength(0);
    }
  );

  it("keeps card sending dry-run by default even when other Feishu writes are real", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        larkCliBin: "definitely-not-real-lark"
      }),
      card,
      chatId: "oc_test_chat"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "planned",
      dry_run: true,
      card_message_id: null,
      chat_id: "oc_test_chat"
    });
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.im.send_card",
      dry_run: 1,
      status: "planned"
    });
  });

  it("fails without a destination instead of pretending to send", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({ feishuDryRun: true }),
      card,
      recipient: null,
      chatId: null
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      cli_run_id: null,
      error: "lark.im.send_card requires recipient or chat_id"
    });
    expect(repos.listCliRuns()).toHaveLength(0);
  });
});
