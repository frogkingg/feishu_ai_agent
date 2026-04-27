import { ChatContext, NormalizedMessageEvent, PendingConfirmation, Project, RouterDecision } from "./schemas";

export function buildRouterPrompt() {
  return [
    "你是 ProjectPilot 的消息路由器，只输出 JSON。",
    "你的任务不是聊天，而是判断当前消息属于哪个协作域。",
    "",
    "优先级：",
    "1. 明确项目目标、任务、owner、deadline、风险、会议结论 -> project/task/risk/decision",
    "2. 明确创建或修改会议/日程 -> calendar",
    "3. 普通聊天、玩笑、情绪 -> smalltalk/ignore",
    "",
    "不要因为出现“明天/今晚/下周/晚上”等时间词就判断为 calendar。",
    "不要因为出现“我觉得/能不能/可不可以/试试”就判断为 hypothetical。",
    "这些词在中文项目协作中很常见，必须结合上下文判断。",
    "未 @ 且没有高价值项目风险/owner 缺失/任务沉淀点时，通常 silent。",
    "被 @ 或私聊时，不能 silent。",
  ].join("\n");
}

export function buildProjectToolPrompt() {
  return [
    "你是 ProjectPilot 的项目状态提取器，只输出 JSON。",
    "你要从当前消息和项目状态中提取：项目目标、任务、owner、deadline、风险、决策、会议结论、待确认项。",
    "不要编造人名、截止时间、项目名。",
    "没有证据的字段留空，并放入 missingFields。",
    "所有 tasks/risks/decisions 必须带 evidenceText。",
    "写入项目状态默认 requiresConfirmation=true。",
  ].join("\n");
}

export function buildChatPrompt() {
  return [
    "你是飞书群里的 PM 同事。",
    "先回应用户真实问题，再给一个具体下一步。",
    "不要说“无法判断动作”。",
    "不要假装已经执行工具。",
    "如果适合沉淀，说明“我可以帮你记录成任务/风险/项目草案”。",
  ].join("\n");
}

export function buildRouterUserPayload(input: {
  event: NormalizedMessageEvent;
  context: ChatContext;
  activeProjectSummary?: string;
  pendingConfirmation?: PendingConfirmation;
  mentioned: boolean;
  privateChat: boolean;
}) {
  return JSON.stringify({
    current_message: {
      message_id: input.event.messageId,
      sender_id: input.event.senderId,
      sender_name: input.event.senderName,
      text: input.event.text,
      mentions: input.event.mentions || [],
      mentioned: input.mentioned,
      private_chat: input.privateChat,
    },
    recent_context: input.context.messages.slice(-10),
    active_project_summary: input.activeProjectSummary || "",
    pending_confirmation: input.pendingConfirmation
      ? {
          id: input.pendingConfirmation.id,
          action_type: input.pendingConfirmation.actionType,
          created_at: input.pendingConfirmation.createdAt,
          expires_at: input.pendingConfirmation.expiresAt,
        }
      : null,
    output_schema: {
      responseMode: "silent | chat | suggest | confirm_action | execute_action",
      primaryDomain: "project | task | risk | decision | calendar | smalltalk | ignore",
      intent:
        "project_intake | project_update | task_extract | risk_check | decision_capture | calendar_create | calendar_update | smalltalk | ignore",
      topicAction: "none | create_topic | update_topic | close_topic",
      safetyLabel: "normal | joke | insult | hypothetical | ambiguous",
      confidence: 0.0,
      reason: "short Chinese reason",
    },
  });
}

export function buildProjectToolUserPayload(input: {
  event: NormalizedMessageEvent;
  route: RouterDecision;
  context: ChatContext;
  activeProject?: Project;
  activeProjectSummary?: string;
}) {
  return JSON.stringify({
    current_message: {
      message_id: input.event.messageId,
      sender_id: input.event.senderId,
      sender_name: input.event.senderName,
      text: input.event.text,
      mentions: input.event.mentions || [],
    },
    route: input.route,
    recent_context: input.context.messages.slice(-10),
    active_project: input.activeProject || null,
    active_project_summary: input.activeProjectSummary || "",
    output_schema: {
      action:
        "none | project_create | project_update | task_create | risk_create | decision_create | note_create",
      projectMatch: {
        projectId: "",
        projectName: "",
        confidence: 0.0,
      },
      projectDraft: {
        name: "",
        goal: "",
        background: "",
        owners: [],
        members: [],
        milestones: [],
      },
      tasks: [],
      risks: [],
      decisions: [],
      notes: [],
      assistantReply: "",
      missingFields: [],
      requiresConfirmation: true,
      grounding: {
        messageIds: [],
        evidenceTexts: [],
      },
    },
  });
}
