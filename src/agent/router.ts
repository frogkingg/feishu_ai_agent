import { callStructuredLlm } from "../llm/client";
import { buildRouterPrompt, buildRouterUserPayload } from "../llm/prompts";
import {
  ChatContext,
  NormalizedMessageEvent,
  PendingConfirmation,
  PrimaryDomain,
  ResponseMode,
  RouterDecision,
  RouterIntent,
  SafetyLabel,
  TopicAction,
} from "../llm/schemas";

const DEFAULT_BOT_NAMES = ["测试项目知识中枢 Agent", "ProjectPilot", "项目领航员", "机器人"];

function botNames() {
  return (process.env.PROJECTPILOT_BOT_NAMES || DEFAULT_BOT_NAMES.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function normalizeBotText(text: string) {
  return text.toLowerCase().replace(/\s+/g, "");
}

export function isDirectMentionLike(event: NormalizedMessageEvent) {
  const text = normalizeBotText(event.text);
  const names = botNames();
  const mentionedByMetadata = (event.mentions || []).some((mention) => {
    const name = mention.name ? normalizeBotText(mention.name) : "";
    return Boolean(name && names.some((botName) => name.includes(normalizeBotText(botName))));
  });
  if (mentionedByMetadata) {
    return true;
  }
  return names.some((botName) => text.includes(`@${normalizeBotText(botName)}`));
}

export function isPrivateChatLike(event: NormalizedMessageEvent) {
  return event.chatType === "p2p" || event.chatType === "private";
}

export function stripBotMentions(text: string) {
  return botNames()
    .reduce((current, name) => current.replace(new RegExp(`@?${escapeRegExp(name)}`, "gi"), ""), text)
    .replace(/@\S+/g, "")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectSafetyLabelByHardRule(text: string): SafetyLabel | undefined {
  const normalized = stripBotMentions(text);
  if (/(测试一下|试一下机器人|看看你会不会|如果我这么说你会不会|假设我是|假如机器人|研究一下模型|换模型|prompt|提示词)/i.test(normalized)) {
    return "hypothetical";
  }

  if (/(滚|傻逼|笨比|不用来上班|你可以直接走了)/.test(normalized)) {
    return "insult";
  }

  if (/(哈哈|笑死|开玩笑|梗|抽卡|泪目)/.test(normalized)) {
    return "joke";
  }

  return undefined;
}

export function hasHighValueProjectSignal(text: string) {
  return /(owner|负责人|没人负责|没定|阻塞|卡住|风险|延期|来不及|不稳定|拆一下|拆任务|待办|任务|action items?|结论|决策|纪要|复盘|推进|项目|需求|PRD|Demo|文档|知识库)/i.test(
    text,
  );
}

function hasProjectIntakeSignal(text: string) {
  return /(立项|新项目|另一个项目|项目草案|项目领航员|项目空间|目标是|目标：|项目目标|要做|这周要做|本周要做|启动.{0,12}项目|创建.{0,12}项目|新建.{0,12}项目|Demo)/i.test(
    text,
  ) && /(项目|目标|Demo|负责人|负责|成员|分工)/i.test(text);
}

function hasRiskSignal(text: string) {
  return /(风险|来不及|延期|卡住|阻塞|不稳定|没定|没人负责|owner\s*还?没|可能.{0,12}(不行|不稳|延期|来不及)|依赖)/i.test(
    text,
  );
}

function hasDecisionSignal(text: string) {
  return /(结论|决定|决策|会议纪要|纪要|复盘结论|刚才定了|最终定|拍板|记一下结论)/.test(text);
}

function hasTaskSignal(text: string) {
  return /(action items?|待办|任务|拆任务|拆一下|负责|owner|今天先|今晚|明早|明天|截止|ddl|deadline|联调|整理|打通|完成|改完)/i.test(
    text,
  );
}

export function isExplicitCalendarIntent(text: string) {
  const stripped = stripBotMentions(text);
  return (
    /(创建|新建|安排|预约|添加|建个|拉个).{0,18}(日程|日历|会议|同步会|例会|周会|评审会|复盘会|对齐会)/i.test(stripped) ||
    /(改|取消|推迟|提前|换到|挪到).{0,18}(日程|日历|会议|同步会|例会|周会|评审会|复盘会|对齐会)/i.test(stripped)
  );
}

function isCalendarUpdateIntent(text: string) {
  const stripped = stripBotMentions(text);
  return /(改|取消|推迟|提前|换到|挪到).{0,18}(日程|日历|会议|同步会|例会|周会|评审会|复盘会|对齐会)/i.test(
    stripped,
  );
}

function mentionedOrPrivate(event: NormalizedMessageEvent) {
  return isDirectMentionLike(event) || isPrivateChatLike(event);
}

function makeDecision(
  event: NormalizedMessageEvent,
  primaryDomain: PrimaryDomain,
  intent: RouterIntent,
  overrides: Partial<RouterDecision> = {},
): RouterDecision {
  const direct = mentionedOrPrivate(event);
  const responseMode: ResponseMode =
    overrides.responseMode ||
    (primaryDomain === "ignore" ? (direct ? "chat" : "silent") : primaryDomain === "smalltalk" ? (direct ? "chat" : "silent") : "confirm_action");
  return {
    responseMode,
    primaryDomain,
    intent,
    topicAction: overrides.topicAction || (primaryDomain === "ignore" || primaryDomain === "smalltalk" ? "none" : "create_topic"),
    safetyLabel: overrides.safetyLabel || "normal",
    confidence: overrides.confidence ?? 0.72,
    reason: overrides.reason || "offline heuristic",
  };
}

export function routeMessageHeuristically(event: NormalizedMessageEvent, activeProjectSummary = ""): RouterDecision {
  const text = stripBotMentions(event.text);
  const hardSafety = detectSafetyLabelByHardRule(text);
  const direct = mentionedOrPrivate(event);
  const hasActiveProject = Boolean(activeProjectSummary && !activeProjectSummary.includes("还没有项目状态"));

  if (hardSafety === "joke" || hardSafety === "insult" || hardSafety === "hypothetical") {
    return makeDecision(event, direct ? "smalltalk" : "ignore", direct ? "smalltalk" : "ignore", {
      responseMode: direct ? "chat" : "silent",
      safetyLabel: hardSafety,
      confidence: 0.88,
      reason: `hard safety: ${hardSafety}`,
    });
  }

  if (isExplicitCalendarIntent(text)) {
    return makeDecision(event, "calendar", isCalendarUpdateIntent(text) ? "calendar_update" : "calendar_create", {
      responseMode: isCalendarUpdateIntent(text) ? "execute_action" : "confirm_action",
      confidence: 0.86,
      reason: "explicit calendar intent",
    });
  }

  if (hasProjectIntakeSignal(text) && (direct || /项目|目标|Demo|负责人|负责|成员|分工/.test(text))) {
    const explicitNewProject = /(新项目|另一个项目|立项|启动.{0,12}项目|创建.{0,12}项目|新建.{0,12}项目)/i.test(text);
    return makeDecision(event, "project", hasActiveProject && !explicitNewProject ? "project_update" : "project_intake", {
      responseMode: "confirm_action",
      confidence: 0.82,
      reason: "project goal/member intake signal",
    });
  }

  if (hasRiskSignal(text)) {
    return makeDecision(event, "risk", "risk_check", {
      responseMode: direct ? "confirm_action" : "suggest",
      safetyLabel: "normal",
      confidence: 0.82,
      reason: "risk or missing owner signal",
    });
  }

  if (hasTaskSignal(text) && (direct || hasActiveProject || /刚才结论|负责|今天先|明早|今晚|截止|联调|整理|打通/.test(text))) {
    return makeDecision(event, "task", "task_extract", {
      responseMode: direct ? "confirm_action" : "suggest",
      confidence: 0.78,
      reason: "task/action item signal",
    });
  }

  if (hasDecisionSignal(text)) {
    return makeDecision(event, "decision", "decision_capture", {
      responseMode: direct ? "confirm_action" : "suggest",
      confidence: 0.78,
      reason: "decision or meeting conclusion signal",
    });
  }

  if (direct) {
    return makeDecision(event, "smalltalk", "smalltalk", {
      responseMode: "chat",
      confidence: 0.65,
      reason: "mentioned/private without write intent",
    });
  }

  if (hasHighValueProjectSignal(text)) {
    return makeDecision(event, "project", "project_update", {
      responseMode: "suggest",
      confidence: 0.62,
      reason: "high-value project work cue",
    });
  }

  return makeDecision(event, "ignore", "ignore", {
    responseMode: "silent",
    confidence: 0.72,
    reason: "no routing signal",
  });
}

function stringValue(raw: Record<string, unknown>, snake: string, camel: string) {
  const value = raw[snake] || raw[camel];
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function normalizeModelDecision(raw: Record<string, unknown>, fallback: RouterDecision, event: NormalizedMessageEvent): RouterDecision {
  const primaryDomain = stringValue(raw, "primary_domain", "primaryDomain") as PrimaryDomain | undefined;
  const intent = stringValue(raw, "intent", "intent") as RouterIntent | undefined;
  const responseMode = stringValue(raw, "response_mode", "responseMode") as ResponseMode | undefined;
  const topicAction = stringValue(raw, "topic_action", "topicAction") as TopicAction | undefined;
  const safetyLabel = stringValue(raw, "safety_label", "safetyLabel") as SafetyLabel | undefined;
  const hardSafety = detectSafetyLabelByHardRule(event.text);

  const allowedDomains: PrimaryDomain[] = ["project", "task", "risk", "decision", "calendar", "smalltalk", "ignore"];
  const allowedIntents: RouterIntent[] = [
    "project_intake",
    "project_update",
    "task_extract",
    "risk_check",
    "decision_capture",
    "calendar_create",
    "calendar_update",
    "smalltalk",
    "ignore",
  ];
  const allowedModes: ResponseMode[] = ["silent", "chat", "suggest", "confirm_action", "execute_action"];
  const allowedTopics: TopicAction[] = ["none", "create_topic", "update_topic", "close_topic"];
  const allowedSafety: SafetyLabel[] = ["normal", "joke", "insult", "hypothetical", "ambiguous"];

  const next: RouterDecision = {
    responseMode: allowedModes.includes(responseMode as ResponseMode) ? responseMode! : fallback.responseMode,
    primaryDomain: allowedDomains.includes(primaryDomain as PrimaryDomain) ? primaryDomain! : fallback.primaryDomain,
    intent: allowedIntents.includes(intent as RouterIntent) ? intent! : fallback.intent,
    topicAction: allowedTopics.includes(topicAction as TopicAction) ? topicAction! : fallback.topicAction,
    safetyLabel: hardSafety || (allowedSafety.includes(safetyLabel as SafetyLabel) ? safetyLabel! : fallback.safetyLabel),
    confidence: numberValue(raw.confidence, fallback.confidence),
    reason: stringValue(raw, "reason", "reason") || fallback.reason,
  };

  if (next.primaryDomain === "calendar" && !isExplicitCalendarIntent(event.text)) {
    return {
      ...fallback,
      reason: `blocked non-explicit calendar route; model reason: ${next.reason}`,
    };
  }

  if (
    !hardSafety &&
    next.safetyLabel === "hypothetical" &&
    /(能不能|可不可以|试试|我感觉|我觉得)/.test(stripBotMentions(event.text)) &&
    !["smalltalk", "ignore"].includes(next.primaryDomain)
  ) {
    next.safetyLabel = "normal";
  }

  if (mentionedOrPrivate(event) && next.responseMode === "silent") {
    next.responseMode = "chat";
  }
  return next;
}

export async function routeMessageWithRouter(input: {
  event: NormalizedMessageEvent;
  context: ChatContext;
  activeProjectSummary?: string;
  pendingConfirmation?: PendingConfirmation;
  useModel?: boolean;
}): Promise<RouterDecision> {
  const fallback = routeMessageHeuristically(input.event, input.activeProjectSummary);
  if (input.useModel === false || process.env.PROJECTPILOT_OFFLINE_ROUTER === "1") {
    return fallback;
  }

  try {
    const raw = await callStructuredLlm(
      [
        { role: "system", content: buildRouterPrompt() },
        {
          role: "user",
          content: buildRouterUserPayload({
            event: input.event,
            context: input.context,
            activeProjectSummary: input.activeProjectSummary,
            pendingConfirmation: input.pendingConfirmation,
            mentioned: isDirectMentionLike(input.event),
            privateChat: isPrivateChatLike(input.event),
          }),
        },
      ],
      "router",
    );
    return raw ? normalizeModelDecision(raw, fallback, input.event) : fallback;
  } catch (error) {
    console.error("Router Agent 失败，使用离线路由:", error);
    return fallback;
  }
}
