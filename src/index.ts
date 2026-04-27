import { ChildProcess, execFile, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type Identity = "user" | "bot";

interface IncomingMessageEvent {
  type?: string;
  id?: string;
  message_id?: string;
  chat_id?: string;
  chat_type?: string;
  content?: unknown;
  create_time?: string;
  mentions?: Array<Record<string, unknown>>;
  sender_id?: string;
  message_type?: string;
  event?: {
    message?: {
      chat_id?: string;
      chat_type?: string;
      content?: string;
      create_time?: string;
      mentions?: Array<Record<string, unknown>>;
      message_id?: string;
      message_type?: string;
    };
    sender?: {
      sender_id?: {
        open_id?: string;
      };
      sender_type?: string;
      name?: string;
    };
    operator?: {
      open_id?: string;
      user_id?: string;
    };
    action?: {
      value?: unknown;
      tag?: string;
    };
    context?: {
      open_chat_id?: string;
      open_message_id?: string;
    };
  };
  header?: {
    event_type?: string;
  };
}

const MESSAGE_EVENT_TYPE = "im.message.receive_v1";
const CARD_ACTION_EVENT_TYPE = "card.action.trigger";
const EVENT_TYPES = [MESSAGE_EVENT_TYPE, CARD_ACTION_EVENT_TYPE].join(",");
const RESTART_BASE_DELAY_MS = 2_000;
const RESTART_MAX_DELAY_MS = 30_000;
const LARK_BIN = process.env.LARK_CLI_BIN || "lark-cli";
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 20_000);
const LLM_MAX_REPLY_CHARS = Number(process.env.LLM_MAX_REPLY_CHARS || 1_800);
const POLL_INTERVAL_MS = Number(process.env.LARK_POLL_INTERVAL_MS || 5_000);
const DEFAULT_EVENT_DURATION_MINUTES = 30;
const CHINA_TZ_OFFSET = "+08:00";
const CONTEXT_WINDOW_MS = Number(process.env.PROJECTPILOT_CONTEXT_WINDOW_MS || 15 * 60_000);
const CONTEXT_MAX_MESSAGES = Number(process.env.PROJECTPILOT_CONTEXT_MAX_MESSAGES || 20);
const PENDING_ACTIVITY_TTL_MS = Number(
  process.env.PROJECTPILOT_PENDING_ACTIVITY_TTL_MS || 30 * 60_000,
);
const TENTATIVE_ACTIVITY_TTL_MS = Number(
  process.env.PROJECTPILOT_TENTATIVE_ACTIVITY_TTL_MS || 30 * 60_000,
);
const RECENT_ACTIVITY_TTL_MS = Number(
  process.env.PROJECTPILOT_RECENT_ACTIVITY_TTL_MS || 45 * 60_000,
);
const TOPIC_TTL_MS = Number(process.env.PROJECTPILOT_TOPIC_TTL_MS || 24 * 60 * 60_000);
const MEMBER_CACHE_TTL_MS = Number(process.env.PROJECTPILOT_MEMBER_CACHE_TTL_MS || 10 * 60_000);
const BOT_NAMES = (process.env.PROJECTPILOT_BOT_NAMES || "测试项目知识中枢 Agent,ProjectPilot,项目领航员,机器人")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const PROCESSING_REACTION_EMOJI = process.env.PROJECTPILOT_PROCESSING_REACTION_EMOJI || "OnIt";
const PROCESSING_ACK_TEXT = process.env.PROJECTPILOT_PROCESSING_ACK_TEXT || "收到，我看一下。";
const PROJECTPILOT_SKILL_PATH =
  process.env.PROJECTPILOT_SKILL_PATH || join(process.cwd(), "skills/projectpilot-conversation/SKILL.md");
const RUNTIME_DIR = join(process.cwd(), ".runtime");
const RECENT_ACTIVITY_STORE_PATH = join(RUNTIME_DIR, "recent-activities.json");

let listener: ChildProcess | undefined;
let restartCount = 0;
let stopping = false;
let projectPilotSkillCache: string | undefined;
const handledMessageIds = new Set<string>();
const processingReceiptMessageIds = new Set<string>();
const processingReceipts = new Map<string, { reactionId?: string; fallbackSent?: boolean }>();
const chatContexts = new Map<string, ChatContext>();
const pendingActivities = new Map<string, PendingActivity>();
const tentativeActivities = new Map<string, TentativeActivity>();
const recentActivities = new Map<string, RecentActivity>();
const conversationTopics = new Map<string, ConversationTopic[]>();
const chatMemberCache = new Map<string, { fetchedAt: number; members: ChatMember[] }>();

function loadLocalEnv() {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key]) {
      continue;
    }

    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

async function runLarkCli(args: string[], as: Identity = "bot") {
  const { stdout, stderr } = await execFileAsync(LARK_BIN, [...args, "--as", as], {
    timeout: 30_000,
    env: process.env,
  });

  if (stderr.trim()) {
    console.warn("lark-cli stderr:", stderr.trim());
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

async function ensureLarkCliReady() {
  try {
    await execFileAsync(LARK_BIN, ["config", "show"], {
      timeout: 10_000,
      env: process.env,
    });
  } catch (error) {
    console.error(
      [
        `无法使用 ${LARK_BIN} 读取飞书 APP 配置。`,
        "请先运行：lark-cli config init --new",
        "并在开发者后台确认：事件订阅为长连接、已订阅 im.message.receive_v1、已开通 im:message:receive_as_bot。",
      ].join("\n"),
    );
    throw error;
  }
}

function getLlmConfig() {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  const apiUrl = process.env.OPENAI_API_URL || process.env.LLM_API_URL;
  const baseUrl = (
    process.env.OPENAI_BASE_URL ||
    process.env.LLM_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");

  return {
    apiKey,
    apiUrl: apiUrl || `${baseUrl}/chat/completions`,
    model: process.env.OPENAI_MODEL || process.env.LLM_MODEL || "gpt-4o-mini",
  };
}

function getProjectPilotSkill() {
  if (projectPilotSkillCache !== undefined) {
    return projectPilotSkillCache;
  }

  try {
    projectPilotSkillCache = readFileSync(PROJECTPILOT_SKILL_PATH, "utf8").trim();
    console.log(`已加载 ProjectPilot Skill: ${PROJECTPILOT_SKILL_PATH}`);
  } catch (error) {
    console.warn("读取 ProjectPilot Skill 失败，使用内置基础规则:", sanitizeError(error));
    projectPilotSkillCache = "";
  }

  return projectPilotSkillCache;
}

function buildCommsContextPayload(
  event: NormalizedMessageEvent,
  context?: ChatContext,
) {
  const pending = getPendingActivity(event.chatId);
  const recent = getRecentActivity(event.chatId);
  return {
    current_message: {
      sender_id: event.senderId,
      sender_name: event.senderName,
      text: event.text,
      mentions: event.mentions || [],
    },
    recent_context:
      context?.messages.slice(-CONTEXT_MAX_MESSAGES).map((message) => ({
        sender_id: message.senderId,
        sender_name: message.senderName,
        text: message.text,
        mentions: message.mentions,
        create_time: new Date(message.createTime).toISOString(),
      })) || [],
    pending_activity: pending
      ? {
          title: pending.title,
          time_hint: pending.timeHint || "",
          location_hint: pending.locationHint || "",
          missing_fields: pending.missingFields,
          source_text: pending.sourceText,
        }
      : null,
    recent_activity: recent
      ? {
          title: recent.title,
          time_hint: recent.timeHint || "",
          location_hint: recent.locationHint || "",
          start: recent.start || "",
          end: recent.end || "",
          approximate: recent.approximate || false,
        }
      : null,
  };
}

async function callLlm(event: NormalizedMessageEvent, context?: ChatContext) {
  const config = getLlmConfig();
  if (!config) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content: [
              "你是 ProjectPilot，一个常驻在飞书里的 PM 同事型 Agent，不是命令行机器人。",
              "当用户 @ 你或私聊你时，像靠谱同事一样自然回应：先理解问题，再给简短、有建设性的判断、追问或下一步建议。",
              "你可以建议使用飞书动作，例如创建日程、拆任务、沉淀文档，但不能声称已经执行外部操作，除非上下文明确显示工具已经完成。",
              "回复要简洁中文，少套话，避免只说“无法判断动作”。",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          {
            role: "user",
            content: JSON.stringify(buildCommsContextPayload(event, context)),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("LLM API 返回为空");
    }

    return content.slice(0, LLM_MAX_REPLY_CHARS);
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObject(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || content).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM JSON 输出中没有对象");
  }

  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

async function callStructuredLlm(
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<Record<string, unknown> | undefined> {
  const config = getLlmConfig();
  if (!config) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const requestBody = {
      model: config.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages,
    };
    let response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (response.status === 400) {
      const retryBody = { ...requestBody, response_format: undefined };
      response = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(retryBody),
        signal: controller.signal,
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("LLM API 返回为空");
    }

    return extractJsonObject(content);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendMessage(event: NormalizedMessageEvent, content: string) {
  if (event.messageId) {
    return runLarkCli([
      "im",
      "+messages-reply",
      "--message-id",
      event.messageId,
      "--text",
      content,
    ]);
  }

  if (!event.chatId) {
    throw new Error("事件中没有 message_id 或 chat_id，无法回复消息");
  }

  return runLarkCli([
    "im",
    "+messages-send",
    "--chat-id",
    event.chatId,
    "--text",
    content,
  ]);
}

async function sendInteractiveMessage(event: NormalizedMessageEvent, card: Record<string, unknown>) {
  const content = JSON.stringify(card);

  if (event.messageId) {
    return runLarkCli([
      "im",
      "+messages-reply",
      "--message-id",
      event.messageId,
      "--msg-type",
      "interactive",
      "--content",
      content,
    ]);
  }

  if (!event.chatId) {
    throw new Error("事件中没有 message_id 或 chat_id，无法回复卡片");
  }

  return runLarkCli([
    "im",
    "+messages-send",
    "--chat-id",
    event.chatId,
    "--msg-type",
    "interactive",
    "--content",
    content,
  ]);
}

async function updateInteractiveMessage(messageId: string, card: Record<string, unknown>) {
  const content = JSON.stringify(card);

  try {
    return await runLarkCli(
      [
        "api",
        "PATCH",
        `/open-apis/im/v1/messages/${messageId}`,
        "--data",
        JSON.stringify({ content }),
      ],
      "bot",
    );
  } catch (error) {
    console.warn("通过 im/v1/messages 更新卡片失败，尝试 interactive/v1/card/update:", sanitizeError(error));
    return runLarkCli(
      [
        "api",
        "POST",
        "/open-apis/interactive/v1/card/update",
        "--data",
        JSON.stringify({ open_message_id: messageId, card }),
      ],
      "bot",
    );
  }
}

async function sendAction(event: NormalizedMessageEvent, action: BotAction) {
  if (action.type === "silent") {
    console.log(`静默: ${action.reason}`);
    return;
  }

  if (action.type === "text") {
    await sendMessage(event, action.content);
    return;
  }

  try {
    await sendInteractiveMessage(event, action.card);
  } catch (error) {
    console.error("发送交互卡片失败，降级为文本:", error);
    await sendMessage(event, action.fallbackText);
  }
}

async function addMessageReaction(messageId: string, emojiType: string) {
  return runLarkCli([
    "im",
    "reactions",
    "create",
    "--params",
    JSON.stringify({ message_id: messageId }),
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
  ]);
}

async function deleteMessageReaction(messageId: string, reactionId: string) {
  return runLarkCli([
    "im",
    "reactions",
    "delete",
    "--params",
    JSON.stringify({ message_id: messageId, reaction_id: reactionId }),
  ]);
}

async function listMessageReactions(messageId: string, emojiType: string) {
  return runLarkCli([
    "im",
    "reactions",
    "list",
    "--params",
    JSON.stringify({ message_id: messageId, reaction_type: emojiType, page_size: 20 }),
  ]);
}

interface CalendarIntent {
  summary: string;
  start: string;
  end: string;
  approximate?: boolean;
  approximateLabel?: string;
}

interface CalendarCreateResult {
  reply: string;
  intent?: CalendarIntent;
  calendarId?: string;
  eventId?: string;
  raw?: unknown;
}

interface MentionInfo {
  id?: string;
  name?: string;
}

interface NormalizedMessageEvent {
  type: string;
  messageId?: string;
  chatId?: string;
  chatType?: string;
  senderId?: string;
  senderName?: string;
  senderType?: string;
  messageType?: string;
  mentions?: MentionInfo[];
  createTime?: number;
  text: string;
}

interface ChatContextMessage {
  messageId?: string;
  senderId?: string;
  senderName?: string;
  text: string;
  mentions: MentionInfo[];
  createTime: number;
}

interface ChatContext {
  chatId: string;
  messages: ChatContextMessage[];
}

interface ChatMember {
  openId: string;
  name: string;
}

interface ParticipantCandidate {
  openId: string;
  name: string;
  reason?: string;
}

type IntentKind =
  | "explicit_schedule_create"
  | "social_schedule_candidate"
  | "cancel_or_change_candidate"
  | "project_request"
  | "ignore";

type ResponseMode = "silent" | "chat" | "suggest" | "confirm_action" | "execute_action";

type TopicStatus = "observing" | "proposed" | "confirming" | "committed" | "updating" | "closed";

type TopicKind = "calendar" | "project" | "chat" | "risk";

type TopicAction = "none" | "create_topic" | "update_topic" | "close_topic";

type SafetyLabel = "normal" | "joke" | "insult" | "hypothetical" | "ambiguous";

type ToolIntent =
  | "none"
  | "calendar_create"
  | "calendar_update"
  | "task_create"
  | "project_intake"
  | "doc_update"
  | "risk_check";

interface GroundingEvidence {
  messageIds: string[];
  evidenceTexts: string[];
}

interface IntentDecision {
  intent: IntentKind;
  confidence: number;
  responseMode: ResponseMode;
  toolIntent: ToolIntent;
  topicAction: TopicAction;
  topicId?: string;
  grounding: GroundingEvidence;
  safetyLabel: SafetyLabel;
  assistantReply?: string;
  activityTitle?: string;
  timeHint?: string;
  participantCandidates: ParticipantCandidate[];
  missingFields: string[];
  shouldAskConfirmation: boolean;
  requiresConfirmation: boolean;
  memberLookupIncomplete?: boolean;
}

interface ConversationTopic {
  id: string;
  chatId: string;
  kind: TopicKind;
  status: TopicStatus;
  title: string;
  sourceText: string;
  sourceMessageId?: string;
  sourceSenderId?: string;
  createdAt: number;
  updatedAt: number;
  messageIds: string[];
  evidenceTexts: string[];
  timeHint?: string;
  locationHint?: string;
  participantCandidates: ParticipantCandidate[];
  calendarId?: string;
  eventId?: string;
}

interface PendingActivity {
  id: string;
  topicId?: string;
  chatId: string;
  sourceText: string;
  sourceMessageId?: string;
  sourceSenderId?: string;
  createdAt: number;
  title: string;
  timeHint?: string;
  locationHint?: string;
  participantCandidates: ParticipantCandidate[];
  missingFields: string[];
  memberLookupIncomplete?: boolean;
  status: "pending" | "cancel_confirmation";
}

interface TentativeActivity {
  topicId?: string;
  chatId: string;
  sourceText: string;
  sourceMessageId?: string;
  sourceSenderId?: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  timeHint?: string;
  locationHint?: string;
  detailTexts: string[];
  supporterIds: string[];
}

interface RecentActivity {
  id: string;
  topicId?: string;
  chatId: string;
  sourceText: string;
  sourceMessageId?: string;
  sourceSenderId?: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  timeHint?: string;
  locationHint?: string;
  participantCandidates: ParticipantCandidate[];
  memberLookupIncomplete?: boolean;
  calendarId?: string;
  eventId?: string;
  start?: string;
  end?: string;
  approximate?: boolean;
  cardMessageId?: string;
}

type BotAction =
  | { type: "silent"; reason: string }
  | { type: "text"; content: string }
  | { type: "card"; card: Record<string, unknown>; fallbackText: string };

interface CardActionEvent {
  type: string;
  action?: string;
  candidateId?: string;
  chatId?: string;
  messageId?: string;
  operatorId?: string;
}

const KNOWN_CARD_ACTIONS = new Set([
  "create_schedule",
  "adjust_participants",
  "dismiss_candidate",
  "cancel_candidate",
  "keep_candidate",
]);

function normalizeContent(content: unknown): string {
  if (typeof content !== "string") {
    return "";
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.text === "string") {
      return parsed.text;
    }
    if (typeof parsed?.content === "string") {
      return parsed.content;
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

function parseEventTime(value?: string | number) {
  if (typeof value === "number") {
    return value;
  }
  if (!value) {
    return Date.now();
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed > 10_000_000_000 ? parsed : parsed * 1000;
  }

  return Date.now();
}

function normalizeMentions(mentions: unknown): MentionInfo[] {
  if (!Array.isArray(mentions)) {
    return [];
  }

  const normalized: MentionInfo[] = [];
  for (const mention of mentions) {
    if (!mention || typeof mention !== "object") {
      continue;
    }

    const item = mention as Record<string, unknown>;
    const id =
      typeof item.id === "string"
        ? item.id
        : typeof item.open_id === "string"
          ? item.open_id
          : typeof item.user_id === "string"
            ? item.user_id
            : undefined;
    const name =
      typeof item.name === "string"
        ? item.name
        : typeof item.key === "string"
          ? item.key
          : undefined;
    if (id || name) {
      normalized.push({ id, name });
    }
  }

  return normalized;
}

function getChatContext(chatId: string) {
  let context = chatContexts.get(chatId);
  if (!context) {
    context = { chatId, messages: [] };
    chatContexts.set(chatId, context);
  }

  return context;
}

function pruneChatContext(context: ChatContext, now = Date.now()) {
  const earliest = now - CONTEXT_WINDOW_MS;
  context.messages = context.messages
    .filter((message) => message.createTime >= earliest)
    .slice(-CONTEXT_MAX_MESSAGES);
}

function rememberMessage(event: NormalizedMessageEvent) {
  if (!event.chatId || !event.text.trim()) {
    return undefined;
  }

  const context = getChatContext(event.chatId);
  context.messages.push({
    messageId: event.messageId,
    senderId: event.senderId,
    senderName: event.senderName,
    text: event.text.trim(),
    mentions: event.mentions || [],
    createTime: event.createTime || Date.now(),
  });
  pruneChatContext(context);
  return context;
}

function getRecentContext(event: NormalizedMessageEvent) {
  if (!event.chatId) {
    return { chatId: "", messages: [] };
  }

  const context = getChatContext(event.chatId);
  pruneChatContext(context);
  return context;
}

function normalizeBotText(text: string) {
  return text.toLowerCase().replace(/\s+/g, "");
}

function isDirectMention(event: NormalizedMessageEvent) {
  const text = normalizeBotText(event.text);
  const mentionedByMetadata = (event.mentions || []).some((mention) => {
    const name = mention.name ? normalizeBotText(mention.name) : "";
    return Boolean(name && BOT_NAMES.some((botName) => name.includes(normalizeBotText(botName))));
  });

  if (mentionedByMetadata) {
    return true;
  }

  return BOT_NAMES.some((botName) => {
    const normalizedName = normalizeBotText(botName);
    return text.includes(`@${normalizedName}`);
  });
}

function isPrivateChat(event: NormalizedMessageEvent) {
  return event.chatType === "p2p" || event.chatType === "private";
}

function isPingIntent(text: string) {
  return text.includes("在吗") || text.includes("在线") || /\bping\b/i.test(text);
}

function isGreetingIntent(text: string) {
  return text.includes("你好") || /\bhello\b/i.test(text);
}

function isProjectIntent(text: string) {
  return /(创建|新建|启动|立项).{0,12}(项目|空间|知识库)|项目.{0,8}(拆解|推进|风险|待办)/.test(
    text,
  );
}

function isCancelExpression(text: string) {
  return /(确认取消|取消候选|先不创建|不用创建|不创建了|不去了|不吃了|不约了|算了|取消|还是不.*了|不想.*了|先不.*了)/.test(
    text,
  );
}

function isKeepCandidate(text: string) {
  return /(保留|先保留|继续保留|还是保留)/.test(text);
}

function isCreateConfirmation(text: string) {
  return /(确认创建|创建日程|就这样|可以创建|帮我创建|安排上|确认安排)/.test(text);
}

function isAgreementExpression(text: string) {
  return /(^|\s|[，,。！!])(\+1|好啊|好呀|可以|可|行|没问题|走|冲|去啊|去呀|我可以|我也想|同意|赞成|就这个|定了|安排)(\s|[，,。！!]|$)/.test(
    text,
  );
}

function isOpinionSeekingExpression(text: string) {
  return /(你们觉得|大家觉得|觉得呢|怎么样|如何|好不好|行不行|可以吗|要不要|有人想|有人要|想不想|去不去|吗[？?]?|[？?])/.test(
    text,
  );
}

function isStrongScheduleDecision(text: string) {
  return /(定了|就这么定|就这个|安排一下|安排上|创建日程|拉个日程|建个日程|确定|确认|那就|就明天|就今晚)/.test(
    text,
  );
}

function isParticipantAdjustment(text: string) {
  return /(加上|带上|拉上|别拉|去掉|调整参与人|参与人)/.test(text) || isCollectiveParticipantRequest(text);
}

function isTimeSupplement(text: string) {
  return /(今天|今晚|明天|明晚|后天|上午|中午|下午|晚上|周末|下周|周[一二三四五六日天]|\d{1,2}[:：点]|[一二两三四五六七八九十]{1,3}点)/.test(
    text,
  );
}

function isNegativeActivityMessage(text: string) {
  return /(不想|不去|不吃|不约|算了|取消|别|还是不)/.test(text);
}

function detectSafetyLabel(event: NormalizedMessageEvent): SafetyLabel {
  const text = stripBotMentions(event.text);
  if (/(如果|假如|要是|能不能|可不可以|试试|看看会不会|待会.*改|我感觉|我觉得)/.test(text)) {
    return "hypothetical";
  }

  if (/(哈哈|笑死|666|抽卡|开玩笑|梗|吐槽|泪目|死掉|笨比|真笨|傻|离职|不用来上班|工作能力.*差|你可以直接走了|滚)/.test(text)) {
    if (/(笨|傻|离职|不用来上班|工作能力.*差|你可以直接走了|滚)/.test(text)) {
      return "insult";
    }
    return "joke";
  }

  if (/(可能|也许|大概|不确定|看看有没有问题|没有问题的话)/.test(text)) {
    return "ambiguous";
  }

  return "normal";
}

function hasActivityKeyword(text: string) {
  return /(烧烤|聚餐|约饭|吃饭|火锅|团建|出去玩|唱歌|咖啡|看电影|喝酒|夜宵|午饭|晚饭|活动|小聚|寿司|寿司朗|日料|烤肉|牛排|牛扒|餐厅|饭店|自助|小龙虾|披萨|汉堡|拉面|居酒屋|海底捞|吃(?!吗|不|没|了|吧|嘛|么)[^，,。；;\n？?]{1,20})/.test(
    text,
  );
}

function hasGroupPlanningCue(text: string) {
  return /(一起|我们|他们|她们|大家|全员|全部人|所有人|要不要|去不去|想去|约|安排|明天|今晚|晚上|周末|下周|改天|几点|什么时候|拉上|带上)/.test(
    text,
  );
}

function hasModelRoutingCue(event: NormalizedMessageEvent) {
  const text = event.text.trim();
  const hasTime = isTimeSupplement(text);
  const hasCollective =
    /(我们|大家|全员|所有人|一起|你们|有人|同事|团队|群里)/.test(text) ||
    Boolean(event.mentions?.length);
  const hasAction = /(吃|去|约|聚|玩|喝|看|唱|打|集合|见|安排|创建|加上|带上|参加|报名|定|改到|取消)/.test(
    text,
  );
  const asksForOpinion = isOpinionSeekingExpression(text);

  return (hasTime && (hasCollective || hasAction)) || (hasCollective && hasAction) || (asksForOpinion && hasAction);
}

function hasConstructiveWorkCue(text: string) {
  return /(owner|负责人|没人负责|没定|阻塞|卡住|风险|延期|来不及|拆一下|拆任务|待办|任务|结论|决策|纪要|复盘|同步|推进|项目|需求|PRD|Demo|文档|知识库)/i.test(
    text,
  );
}

function isSocialScheduleCandidate(text: string) {
  if (!hasActivityKeyword(text) || isNegativeActivityMessage(text)) {
    return false;
  }

  return hasGroupPlanningCue(text);
}

function isTentativeSocialCandidate(event: NormalizedMessageEvent, text: string) {
  if (!isSocialScheduleCandidate(text) || isStrongScheduleDecision(text) || isCalendarCreateIntent(text)) {
    return false;
  }

  if (isDirectMention(event) || isPrivateChat(event)) {
    return false;
  }

  return true;
}

function extractLocationHint(text: string) {
  const match = text.match(/(?:在|去)([^，,。；;\n]{2,40}?)(?:吃|聚|集合|见|吧|$)/);
  return match?.[1]?.trim();
}

function hasActivityDetail(text: string) {
  return isTimeSupplement(text) || Boolean(extractLocationHint(text)) || isParticipantAdjustment(text);
}

function shouldRespond(event: NormalizedMessageEvent, context: ChatContext): boolean {
  const text = event.text.trim();
  if (!text) {
    return false;
  }

  const pending = getPendingActivity(event.chatId);
  const tentative = getTentativeActivity(event.chatId);
  const recent = getRecentActivity(event.chatId);
  const pendingRelevant = isPendingActivityFollowup(event, pending, text);
  const tentativeRelevant = isTentativeActivityFollowup(event, tentative, text);
  if (
    pending &&
    pendingRelevant &&
    (isCancelExpression(text) ||
      isCreateConfirmation(text) ||
      isParticipantAdjustment(text) ||
      isTimeSupplement(text) ||
      isKeepCandidate(text))
  ) {
    return true;
  }

  if (pending && pendingRelevant && pending.sourceSenderId && event.senderId === pending.sourceSenderId) {
    return true;
  }

  if (pending && pendingRelevant && (isAgreementExpression(text) || mentionsCollectiveOrPronoun(text) || hasModelRoutingCue(event))) {
    return true;
  }

  if (isRecentActivityFollowup(event, recent, text)) {
    return true;
  }

  if (isPrivateChat(event) || isDirectMention(event)) {
    return true;
  }

  if (tentative && tentativeRelevant && shouldPromoteTentativeActivity(event, tentative, text)) {
    return true;
  }

  if (isTentativeSocialCandidate(event, text)) {
    return false;
  }

  if (isCalendarCreateIntent(text) || isProjectIntent(text)) {
    return true;
  }

  if (hasConstructiveWorkCue(text)) {
    return true;
  }

  if (isSocialScheduleCandidate(text)) {
    return true;
  }

  if (context.messages.length >= 2 && pending && pendingRelevant && isCancelExpression(text)) {
    return true;
  }

  return false;
}

function shouldSendProcessingReceipt(event: NormalizedMessageEvent, context: ChatContext) {
  if (!event.messageId || event.senderType === "app") {
    return false;
  }

  if (processingReceiptMessageIds.has(event.messageId)) {
    return false;
  }

  if (
    !isDirectMention(event) &&
    !isPrivateChat(event) &&
    !isPendingActivityFollowup(event, getPendingActivity(event.chatId), event.text) &&
    !isRecentActivityFollowup(event, getRecentActivity(event.chatId), event.text)
  ) {
    return false;
  }

  return shouldRespond(event, context);
}

async function sendProcessingReceipt(event: NormalizedMessageEvent, context: ChatContext) {
  if (!shouldSendProcessingReceipt(event, context) || !event.messageId) {
    return;
  }

  processingReceiptMessageIds.add(event.messageId);
  try {
    const result = await addMessageReaction(event.messageId, PROCESSING_REACTION_EMOJI);
    const reactionId = findStringDeep(result, ["reaction_id", "reactionId", "id"]);
    processingReceipts.set(event.messageId, { reactionId });
    console.log(`已发送处理中表情: ${PROCESSING_REACTION_EMOJI} message_id=${event.messageId}`);
  } catch (error) {
    console.warn("发送处理中表情失败，降级为短回复:", sanitizeError(error));
    try {
      await sendMessage(event, PROCESSING_ACK_TEXT);
      processingReceipts.set(event.messageId, { fallbackSent: true });
    } catch (fallbackError) {
      console.warn("发送处理中短回复失败:", sanitizeError(fallbackError));
    }
  }
}

async function clearProcessingReceipt(event: NormalizedMessageEvent) {
  if (!event.messageId) {
    return;
  }

  const receipt = processingReceipts.get(event.messageId);
  if (!receipt) {
    return;
  }

  processingReceipts.delete(event.messageId);
  let reactionId = receipt.reactionId;
  if (!reactionId) {
    try {
      const result = await listMessageReactions(event.messageId, PROCESSING_REACTION_EMOJI);
      reactionId = findStringDeep(result, ["reaction_id", "reactionId"]);
    } catch (error) {
      console.warn("查找处理中表情失败，跳过移除:", sanitizeError(error));
    }
  }

  if (!reactionId) {
    return;
  }

  try {
    await deleteMessageReaction(event.messageId, reactionId);
    console.log(`已移除处理中表情 message_id=${event.messageId}`);
  } catch (error) {
    console.warn("移除处理中表情失败:", sanitizeError(error));
  }
}

function getPendingActivity(chatId?: string) {
  if (!chatId) {
    return undefined;
  }

  const pending = pendingActivities.get(chatId);
  if (!pending) {
    return undefined;
  }

  if (Date.now() - pending.createdAt > PENDING_ACTIVITY_TTL_MS) {
    pendingActivities.delete(chatId);
    return undefined;
  }

  return pending;
}

function getTentativeActivity(chatId?: string) {
  if (!chatId) {
    return undefined;
  }

  const tentative = tentativeActivities.get(chatId);
  if (!tentative) {
    return undefined;
  }

  if (Date.now() - tentative.updatedAt > TENTATIVE_ACTIVITY_TTL_MS) {
    tentativeActivities.delete(chatId);
    return undefined;
  }

  return tentative;
}

function getRecentActivity(chatId?: string) {
  if (!chatId) {
    return undefined;
  }

  const recent = recentActivities.get(chatId);
  if (!recent) {
    return undefined;
  }

  if (Date.now() - recent.updatedAt > RECENT_ACTIVITY_TTL_MS) {
    deleteRecentActivity(chatId);
    return undefined;
  }

  return recent;
}

function persistRecentActivities() {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(
      RECENT_ACTIVITY_STORE_PATH,
      JSON.stringify([...recentActivities.values()], null, 2),
    );
  } catch (error) {
    console.warn("保存最近日程上下文失败:", sanitizeError(error));
  }
}

function setRecentActivity(recent: RecentActivity) {
  recentActivities.set(recent.chatId, recent);
  persistRecentActivities();
}

function deleteRecentActivity(chatId: string) {
  recentActivities.delete(chatId);
  persistRecentActivities();
}

function loadRecentActivities() {
  if (!existsSync(RECENT_ACTIVITY_STORE_PATH)) {
    return;
  }

  try {
    const parsed = JSON.parse(readFileSync(RECENT_ACTIVITY_STORE_PATH, "utf8"));
    const activities = Array.isArray(parsed) ? parsed : [];
    const now = Date.now();
    for (const activity of activities) {
      if (!activity || typeof activity !== "object") {
        continue;
      }
      const recent = activity as RecentActivity;
      if (!recent.chatId || !recent.updatedAt || now - recent.updatedAt > RECENT_ACTIVITY_TTL_MS) {
        continue;
      }
      recentActivities.set(recent.chatId, recent);
    }
    persistRecentActivities();
  } catch (error) {
    console.warn("读取最近日程上下文失败，已忽略本地缓存:", sanitizeError(error));
  }
}

function createTopicId(event: NormalizedMessageEvent) {
  return `${event.chatId || "dm"}:${event.messageId || Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function getTopics(chatId?: string) {
  if (!chatId) {
    return [];
  }

  const now = Date.now();
  const topics = conversationTopics.get(chatId) || [];
  const activeTopics = topics.filter(
    (topic) => topic.status !== "closed" && now - topic.updatedAt <= TOPIC_TTL_MS,
  );
  if (activeTopics.length !== topics.length) {
    conversationTopics.set(chatId, activeTopics);
  }
  return activeTopics;
}

function setTopic(topic: ConversationTopic) {
  const topics = getTopics(topic.chatId).filter((item) => item.id !== topic.id);
  topics.push(topic);
  conversationTopics.set(topic.chatId, topics.slice(-20));
  return topic;
}

function getTopic(chatId?: string, topicId?: string) {
  if (!chatId || !topicId) {
    return undefined;
  }
  return getTopics(chatId).find((topic) => topic.id === topicId);
}

function hasSameActivityKind(title: string, text: string) {
  if (/(聚餐|吃饭|烧烤|火锅|海底捞|寿司|日料|烤肉|饭)/.test(title)) {
    return /(聚餐|吃饭|烧烤|火锅|海底捞|寿司|日料|烤肉|饭|参加|参与人)/.test(text);
  }
  if (/(会议|会|同步|复盘|评审)/.test(title)) {
    return /(会议|开会|同步|复盘|评审|主题|参会|参与人)/.test(text);
  }
  return title.length > 1 && text.includes(title);
}

function hasCalendarUpdateContent(text: string) {
  return Boolean(
    isTimeSupplement(text) ||
      isParticipantAdjustment(text) ||
      hasActivityKeyword(text) ||
      extractLocationHint(text) ||
      /(时间|地点|参与人|人员|日程|安排|活动|会议|聚餐)/.test(text),
  );
}

function looksLikeNewCalendarTopic(text: string) {
  return (
    !/(不对|改到|改成|改为|换到|换成|挪到|提前|推迟|加上|带上|拉上|去掉|别拉|取消)/.test(text) &&
    (isCalendarCreateIntent(text) ||
      (isTimeSupplement(text) && /(会议|开会|聚餐|吃饭|团建|活动|复盘|评审|同步)/.test(text)))
  );
}

function isActivityReference(text: string, activity: { title: string; locationHint?: string; sourceSenderId?: string }, event: NormalizedMessageEvent) {
  const directObject =
    text.includes(activity.title) ||
    (activity.locationHint ? text.includes(activity.locationHint) : false) ||
    /(?:这个|刚才|刚刚|那个).{0,10}(日程|安排|聚餐|吃饭|会议|活动|时间|地点|参与人|人员)/.test(text);
  const sameStarter = Boolean(activity.sourceSenderId && event.senderId === activity.sourceSenderId);
  return directObject || (sameStarter && hasSameActivityKind(activity.title, text));
}

function isRecentActivityFollowup(
  event: NormalizedMessageEvent,
  recent: RecentActivity | undefined,
  text: string,
) {
  if (!recent || !text.trim()) {
    return false;
  }

  if (looksLikeNewCalendarTopic(text)) {
    return false;
  }

  const asksForChange =
    /(?:不对|改到|改成|改为|换到|换成|挪到|提前|推迟|加上|带上|拉上|去掉|别拉|取消|不去了|不吃了|算了)/.test(
      text,
    );
  const refersToKnownActivity = isActivityReference(text, recent, event);

  return (
    (asksForChange && refersToKnownActivity && hasCalendarUpdateContent(text)) ||
    (refersToKnownActivity && (isTimeSupplement(text) || isParticipantAdjustment(text))) ||
    (isDirectMention(event) && refersToKnownActivity)
  );
}

function isPendingActivityFollowup(
  event: NormalizedMessageEvent,
  pending: PendingActivity | undefined,
  text: string,
) {
  if (!pending || !text.trim()) {
    return false;
  }

  if (looksLikeNewCalendarTopic(text) && !text.includes(pending.title)) {
    return false;
  }

  if (isCreateConfirmation(text) || isKeepCandidate(text) || isCancelExpression(text)) {
    return isActivityReference(text, pending, event) || event.senderId === pending.sourceSenderId;
  }

  return isActivityReference(text, pending, event) && hasCalendarUpdateContent(text);
}

function isTentativeActivityFollowup(
  event: NormalizedMessageEvent,
  tentative: TentativeActivity | undefined,
  text: string,
) {
  if (!tentative || !text.trim()) {
    return false;
  }

  if (looksLikeNewCalendarTopic(text) && !text.includes(tentative.title)) {
    return false;
  }

  return (
    isActivityReference(text, tentative, event) ||
    event.senderId === tentative.sourceSenderId ||
    hasActivityDetail(text) ||
    isAgreementExpression(text)
  );
}

function createOrUpdateTopicFromActivity(
  event: NormalizedMessageEvent,
  activity: {
    topicId?: string;
    chatId: string;
    title: string;
    sourceText: string;
    sourceMessageId?: string;
    sourceSenderId?: string;
    timeHint?: string;
    locationHint?: string;
    participantCandidates?: ParticipantCandidate[];
    calendarId?: string;
    eventId?: string;
  },
  status: TopicStatus,
) {
  const existing = getTopic(activity.chatId, activity.topicId);
  const topic: ConversationTopic =
    existing || {
      id: activity.topicId || createTopicId(event),
      chatId: activity.chatId,
      kind: "calendar",
      status,
      title: activity.title,
      sourceText: activity.sourceText,
      sourceMessageId: activity.sourceMessageId,
      sourceSenderId: activity.sourceSenderId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageIds: [],
      evidenceTexts: [],
      participantCandidates: [],
    };

  topic.status = status;
  topic.title = activity.title || topic.title;
  topic.timeHint = activity.timeHint || topic.timeHint;
  topic.locationHint = activity.locationHint || topic.locationHint;
  topic.calendarId = activity.calendarId || topic.calendarId;
  topic.eventId = activity.eventId || topic.eventId;
  topic.participantCandidates = activity.participantCandidates || topic.participantCandidates;
  topic.updatedAt = Date.now();
  topic.messageIds = [...new Set([...topic.messageIds, activity.sourceMessageId, event.messageId].filter(Boolean) as string[])].slice(-20);
  topic.evidenceTexts = [...new Set([...topic.evidenceTexts, activity.sourceText, event.text].filter(Boolean))].slice(-12);
  return setTopic(topic);
}

function getRelatedTopic(event: NormalizedMessageEvent, text = event.text) {
  const pending = getPendingActivity(event.chatId);
  if (isPendingActivityFollowup(event, pending, text) && pending?.topicId) {
    return getTopic(event.chatId, pending.topicId);
  }

  const recent = getRecentActivity(event.chatId);
  if (isRecentActivityFollowup(event, recent, text) && recent?.topicId) {
    return getTopic(event.chatId, recent.topicId);
  }

  const topics = getTopics(event.chatId).sort((a, b) => b.updatedAt - a.updatedAt);
  return topics.find((topic) => isActivityReference(text, topic, event) && hasCalendarUpdateContent(text));
}

function getRelevantContextMessages(context: ChatContext, topic?: ConversationTopic) {
  if (!topic) {
    return context.messages.slice(-8);
  }

  const topicMessageIds = new Set(topic.messageIds);
  const related = context.messages.filter(
    (message) =>
      (message.messageId && topicMessageIds.has(message.messageId)) ||
      message.text.includes(topic.title) ||
      topic.evidenceTexts.some((evidence) => evidence && message.text.includes(evidence)),
  );
  return [...related, ...context.messages.slice(-5)].slice(-10);
}

function rememberTentativeActivity(
  event: NormalizedMessageEvent,
  context: ChatContext,
  decision?: IntentDecision,
) {
  if (!event.chatId) {
    return undefined;
  }

  const existing = getTentativeActivity(event.chatId);
  const timeHint = decision?.timeHint || inferTimeHint(event.text) || existing?.timeHint;
  const locationHint = extractLocationHint(event.text) || existing?.locationHint;
  const detailTexts = existing?.detailTexts || [];
  if (hasActivityDetail(event.text)) {
    detailTexts.push(event.text);
  }

  const tentative: TentativeActivity = {
    topicId: existing?.topicId,
    chatId: event.chatId,
    sourceText: existing?.sourceText || event.text,
    sourceMessageId: existing?.sourceMessageId || event.messageId,
    sourceSenderId: existing?.sourceSenderId || event.senderId,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    title: existing?.title || normalizeActivityTitle(decision?.activityTitle, event.text),
    timeHint,
    locationHint,
    detailTexts: detailTexts.slice(-8),
    supporterIds: existing?.supporterIds || [],
  };

  const topic = createOrUpdateTopicFromActivity(event, tentative, "observing");
  tentative.topicId = topic.id;

  tentativeActivities.set(event.chatId, tentative);
  console.log(
    `记录候选活动: ${tentative.title} time=${tentative.timeHint || "(none)"} location=${tentative.locationHint || "(none)"}`,
  );
  return tentative;
}

function shouldPromoteTentativeActivity(
  event: NormalizedMessageEvent,
  tentative: TentativeActivity,
  text: string,
) {
  if (isNegativeActivityMessage(text) || isCancelExpression(text)) {
    return false;
  }

  if (isStrongScheduleDecision(text) || isCreateConfirmation(text) || isCalendarCreateIntent(text)) {
    return true;
  }

  if (isAgreementExpression(text)) {
    return !tentative.sourceSenderId || !event.senderId || event.senderId !== tentative.sourceSenderId;
  }

  return false;
}

function updateTentativeFromMessage(tentative: TentativeActivity, event: NormalizedMessageEvent) {
  tentative.updatedAt = Date.now();
  tentative.timeHint = inferTimeHint(event.text) || tentative.timeHint;
  tentative.locationHint = extractLocationHint(event.text) || tentative.locationHint;
  if (hasActivityDetail(event.text)) {
    tentative.detailTexts = [...tentative.detailTexts, event.text].slice(-8);
  }
  if (event.senderId && isAgreementExpression(event.text) && !tentative.supporterIds.includes(event.senderId)) {
    tentative.supporterIds.push(event.senderId);
  }
  const topic = createOrUpdateTopicFromActivity(event, tentative, "proposed");
  tentative.topicId = topic.id;
  tentativeActivities.set(tentative.chatId, tentative);
}

function inferActivityTitle(text: string) {
  const quoted = text.match(/[「“"]([^」”"]{2,60})[」”"]/);
  if (quoted) {
    return quoted[1].trim();
  }

  if (text.includes("烧烤")) {
    return "烧烤聚餐";
  }
  if (text.includes("火锅")) {
    return "火锅聚餐";
  }
  if (text.includes("团建")) {
    return "团队团建";
  }
  if (text.includes("看电影")) {
    return "一起看电影";
  }
  if (text.includes("唱歌")) {
    return "唱歌小聚";
  }
  if (text.includes("咖啡")) {
    return "咖啡小聚";
  }
  if (/(聚餐|约饭|吃饭|午饭|晚饭|夜宵)/.test(text)) {
    return "团队聚餐";
  }

  return extractSummary(text);
}

function stripBotMentions(text: string) {
  let stripped = text;
  for (const botName of BOT_NAMES) {
    stripped = stripped.replace(new RegExp(`@?${escapeRegExp(botName)}`, "g"), "");
  }
  return stripped.replace(/@\S+/g, "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SPECIFIC_ACTIVITY_TITLE_TOKENS = [
  "寿司朗",
  "海底捞",
  "烧烤",
  "火锅",
  "烤肉",
  "寿司",
  "日料",
  "牛排",
  "牛扒",
  "小龙虾",
  "披萨",
  "汉堡",
  "拉面",
  "居酒屋",
  "咖啡",
  "电影",
  "唱歌",
  "KTV",
  "T2",
];

function isUngroundedActivityTitle(title: string, sourceText: string) {
  const source = stripBotMentions(sourceText);
  return SPECIFIC_ACTIVITY_TITLE_TOKENS.some((token) => title.includes(token) && !source.includes(token));
}

function normalizeActivityTitle(title: string | undefined, sourceText: string) {
  const cleanedSource = stripBotMentions(sourceText);
  const raw = (title || inferActivityTitle(cleanedSource)).trim();
  const cleaned = stripBotMentions(raw)
    .replace(/(创建|新建|安排|预约|添加|拉个|建个|日程|日历|会议|吧|一下|我们全部人|全部人|所有人|大家|他们|她们|应该也想去|想去|想吃|我想吃|晚上|明天|今晚|明晚|今天|后天)/g, " ")
    .replace(/[，,。；;：:！!？?\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned && isUngroundedActivityTitle(cleaned, cleanedSource)) {
    return inferActivityTitle(cleanedSource);
  }

  if (cleaned && cleaned.length <= 16 && !cleaned.includes("@")) {
    if (/寿司朗/.test(cleaned) && !/(聚餐|吃饭|小聚)/.test(cleaned)) {
      return "寿司朗聚餐";
    }
    if (/(烧烤|火锅|烤肉|日料|牛排|牛扒|小龙虾|披萨|汉堡|拉面|海底捞)/.test(cleaned) && !/(聚餐|吃饭|小聚)/.test(cleaned)) {
      return `${cleaned}聚餐`;
    }
    return cleaned;
  }

  return inferActivityTitle(cleanedSource);
}

function inferTimeHint(text: string) {
  const patterns = [
    /(今天|今晚|明天|明晚|后天|周末|本周末|下周[一二三四五六日天]?|周[一二三四五六日天])\s*(早上|上午|中午|下午|晚上|今晚|明晚)?\s*(\d{1,2}(?:[:：点]\d{0,2})?)?/,
    /(早上|上午|中午|下午|晚上|今晚|明晚)\s*(\d{1,2}(?:[:：点]\d{0,2})?)?/,
    /\d{1,2}(?:[:：点]\d{0,2})/,
  ];

  for (const pattern of patterns) {
    const value = text.match(pattern)?.[0]?.trim();
    if (value) {
      return value.replace(/\s+/g, "");
    }
  }

  if (text.includes("改天")) {
    return "改天";
  }

  return undefined;
}

function hasExplicitCalendarTime(text: string) {
  try {
    return Boolean(parseCalendarIntent(`创建日程「测试」 ${text}`));
  } catch {
    return false;
  }
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isBotLikeName(name?: string) {
  if (!name) {
    return false;
  }

  const normalized = normalizeBotText(name);
  return (
    BOT_NAMES.some((botName) => normalized.includes(normalizeBotText(botName))) ||
    /(agent|bot|机器人|智能伙伴|助手)/i.test(name)
  );
}

function isBotLikeMember(member: ChatMember | ParticipantCandidate) {
  return isBotLikeName(member.name);
}

function uniqueByOpenId(candidates: ParticipantCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (isBotLikeMember(candidate)) {
      return false;
    }
    if (seen.has(candidate.openId)) {
      return false;
    }
    seen.add(candidate.openId);
    return true;
  });
}

function fallbackMembersFromContext(context: ChatContext, currentEvent?: NormalizedMessageEvent) {
  const members = new Map<string, ChatMember>();

  for (const message of context.messages) {
    if (message.senderId) {
      members.set(message.senderId, {
        openId: message.senderId,
        name: message.senderName || message.senderId,
      });
    }

    for (const mention of message.mentions) {
      if (mention.id) {
        members.set(mention.id, {
          openId: mention.id,
          name: mention.name || mention.id,
        });
      }
    }
  }

  if (currentEvent?.senderId) {
    members.set(currentEvent.senderId, {
      openId: currentEvent.senderId,
      name: currentEvent.senderName || currentEvent.senderId,
    });
  }

  return [...members.values()];
}

async function getChatMembers(chatId: string, context: ChatContext, event: NormalizedMessageEvent) {
  const cached = chatMemberCache.get(chatId);
  if (cached && Date.now() - cached.fetchedAt <= MEMBER_CACHE_TTL_MS) {
    return { members: cached.members, incomplete: false };
  }

  try {
    const result = await runLarkCli(
      [
        "im",
        "chat.members",
        "get",
        "--params",
        JSON.stringify({ chat_id: chatId, member_id_type: "open_id", page_size: 100 }),
      ],
      "bot",
    );
    const data = result as {
      data?: { items?: Array<Record<string, unknown>> };
      items?: Array<Record<string, unknown>>;
    };
    const items = data.data?.items || data.items || [];
    const members = items
      .map((item) => {
        const openId =
          getString(item.member_id) ||
          getString(item.open_id) ||
          getString(item.user_id) ||
          getString(item.id);
        if (!openId) {
          return undefined;
        }

        const name =
          getString(item.name) ||
          getString(item.member_name) ||
          getString(item.display_name) ||
          openId;
        return { openId, name };
      })
      .filter((member): member is ChatMember => Boolean(member));

    if (members.length) {
      chatMemberCache.set(chatId, { fetchedAt: Date.now(), members });
      return { members, incomplete: false };
    }

    throw new Error("群成员列表为空");
  } catch (error) {
    console.warn(`读取群成员失败，降级到上下文参与人: ${sanitizeError(error)}`);
    return { members: fallbackMembersFromContext(context, event), incomplete: true };
  }
}

function filterParticipantCandidates(rawCandidates: unknown, members: ChatMember[]) {
  if (!Array.isArray(rawCandidates)) {
    return [];
  }

  const byOpenId = new Map(members.map((member) => [member.openId, member]));
  const byName = new Map(members.map((member) => [member.name, member]));
  const candidates: ParticipantCandidate[] = [];

  for (const rawCandidate of rawCandidates) {
    let openId: string | undefined;
    let name: string | undefined;
    let reason: string | undefined;

    if (typeof rawCandidate === "string") {
      openId = rawCandidate.trim();
      name = rawCandidate.trim();
    } else if (rawCandidate && typeof rawCandidate === "object") {
      const item = rawCandidate as Record<string, unknown>;
      openId =
        getString(item.open_id) ||
        getString(item.openId) ||
        getString(item.member_id) ||
        getString(item.id);
      name = getString(item.name) || getString(item.display_name) || getString(item.member_name);
      reason = getString(item.reason);
    }

    const member = (openId && byOpenId.get(openId)) || (name && byName.get(name));
    if (!member) {
      console.warn(`模型推荐了非群成员，已丢弃: ${name || openId || JSON.stringify(rawCandidate)}`);
      continue;
    }

    candidates.push({
      openId: member.openId,
      name: member.name,
      reason,
    });
  }

  return uniqueByOpenId(candidates);
}

function fallbackParticipantCandidates(
  event: NormalizedMessageEvent,
  context: ChatContext,
  members: ChatMember[],
) {
  const byOpenId = new Map(members.map((member) => [member.openId, member]));
  const candidates: ParticipantCandidate[] = [];

  for (const mention of event.mentions || []) {
    const member = mention.id ? byOpenId.get(mention.id) : undefined;
    if (member) {
      candidates.push({ openId: member.openId, name: member.name, reason: "当前消息 @ 提及" });
    }
  }

  if (isCollectiveParticipantRequest(event.text) && members.length) {
    candidates.push(
      ...members.filter((member) => !isBotLikeMember(member)).slice(0, 30).map((member) => ({
        openId: member.openId,
        name: member.name,
        reason: "消息表达为全员参与",
      })),
    );
  } else {
    for (const message of context.messages.slice(-8)) {
      const member = message.senderId ? byOpenId.get(message.senderId) : undefined;
      if (member) {
        candidates.push({
          openId: member.openId,
          name: member.name,
          reason: "最近参与了相关讨论",
        });
      }
    }
  }

  if (event.senderId) {
    const sender = byOpenId.get(event.senderId);
    if (sender) {
      candidates.push({
        openId: sender.openId,
        name: sender.name,
        reason: "活动发起人",
      });
    } else {
      candidates.push({
        openId: event.senderId,
        name: event.senderName || event.senderId,
        reason: "活动发起人",
      });
    }
  }

  return uniqueByOpenId(candidates);
}

function mentionsCollectiveOrPronoun(text: string) {
  return /(他们|她们|他俩|她俩|他们俩|她们俩|我们全部人|全部人|所有人|全员|大家|群里|群成员|成员|我们)/.test(text);
}

function isCollectiveParticipantRequest(text: string) {
  return /(我们全部人|我们所有人|我们都|我们.{0,8}都|全部人|所有人|全员|大家|群里的人|群里的|群成员|全部成员|所有成员)/.test(
    text,
  );
}

function inferParticipantCandidatesFromMembers(
  event: NormalizedMessageEvent,
  context: ChatContext,
  members: ChatMember[],
) {
  if (!members.length) {
    return [];
  }

  const candidates: ParticipantCandidate[] = [];
  for (const member of members) {
    if (isBotLikeMember(member)) {
      continue;
    }

    if (event.text.includes(member.name)) {
      candidates.push({
        openId: member.openId,
        name: member.name,
        reason: "文本直接提到",
      });
    }
  }

  if (mentionsCollectiveOrPronoun(event.text)) {
    const recentSpeakerIds = new Set(
      context.messages
        .slice(-12)
        .map((message) => message.senderId)
        .filter((id): id is string => Boolean(id)),
    );
    const recentMembers = members.filter((member) => recentSpeakerIds.has(member.openId) && !isBotLikeMember(member));
    const source = recentMembers.length >= 2 ? recentMembers : members.filter((member) => !isBotLikeMember(member));
    candidates.push(
      ...source.slice(0, 30).map((member) => ({
        openId: member.openId,
        name: member.name,
        reason: recentMembers.length >= 2 ? "最近参与了上下文" : "群成员名单推断",
      })),
    );
  }

  return uniqueByOpenId(candidates);
}

function normalizeIntent(value: unknown): IntentKind {
  const allowed: IntentKind[] = [
    "explicit_schedule_create",
    "social_schedule_candidate",
    "cancel_or_change_candidate",
    "project_request",
    "ignore",
  ];
  return allowed.includes(value as IntentKind) ? (value as IntentKind) : "ignore";
}

function normalizeResponseMode(value: unknown): ResponseMode {
  const allowed: ResponseMode[] = ["silent", "chat", "suggest", "confirm_action", "execute_action"];
  return allowed.includes(value as ResponseMode) ? (value as ResponseMode) : "silent";
}

function normalizeToolIntent(value: unknown): ToolIntent {
  const allowed: ToolIntent[] = [
    "none",
    "calendar_create",
    "calendar_update",
    "task_create",
    "project_intake",
    "doc_update",
    "risk_check",
  ];
  return allowed.includes(value as ToolIntent) ? (value as ToolIntent) : "none";
}

function normalizeTopicAction(value: unknown): TopicAction {
  const allowed: TopicAction[] = ["none", "create_topic", "update_topic", "close_topic"];
  return allowed.includes(value as TopicAction) ? (value as TopicAction) : "none";
}

function normalizeSafetyLabel(value: unknown): SafetyLabel {
  const allowed: SafetyLabel[] = ["normal", "joke", "insult", "hypothetical", "ambiguous"];
  return allowed.includes(value as SafetyLabel) ? (value as SafetyLabel) : "normal";
}

function defaultResponseMode(intent: IntentKind): ResponseMode {
  if (intent === "ignore") {
    return "silent";
  }
  if (intent === "social_schedule_candidate") {
    return "confirm_action";
  }
  if (intent === "explicit_schedule_create" || intent === "cancel_or_change_candidate") {
    return "execute_action";
  }
  return "chat";
}

function defaultToolIntent(intent: IntentKind): ToolIntent {
  if (intent === "explicit_schedule_create" || intent === "social_schedule_candidate") {
    return "calendar_create";
  }
  if (intent === "cancel_or_change_candidate") {
    return "calendar_update";
  }
  if (intent === "project_request") {
    return "project_intake";
  }
  return "none";
}

function defaultTopicAction(intent: IntentKind): TopicAction {
  if (intent === "social_schedule_candidate" || intent === "explicit_schedule_create") {
    return "create_topic";
  }
  if (intent === "cancel_or_change_candidate" || intent === "project_request") {
    return "update_topic";
  }
  return "none";
}

function defaultGrounding(event: NormalizedMessageEvent): GroundingEvidence {
  return {
    messageIds: event.messageId ? [event.messageId] : [],
    evidenceTexts: [stripBotMentions(event.text)].filter(Boolean),
  };
}

function normalizeGrounding(value: unknown, event: NormalizedMessageEvent): GroundingEvidence {
  if (!value || typeof value !== "object") {
    return defaultGrounding(event);
  }

  const raw = value as Record<string, unknown>;
  const messageIds =
    normalizeStringArray(raw.message_ids).length > 0
      ? normalizeStringArray(raw.message_ids)
      : normalizeStringArray(raw.messageIds);
  const evidenceTexts =
    normalizeStringArray(raw.evidence_texts).length > 0
      ? normalizeStringArray(raw.evidence_texts)
      : normalizeStringArray(raw.evidenceTexts);
  const fallback = defaultGrounding(event);
  return {
    messageIds: messageIds.length ? messageIds : fallback.messageIds,
    evidenceTexts: evidenceTexts.length ? evidenceTexts : fallback.evidenceTexts,
  };
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

async function classifyWithModel(
  event: NormalizedMessageEvent,
  context: ChatContext,
  members: ChatMember[],
  memberLookupIncomplete: boolean,
) {
  const relatedTopic = getRelatedTopic(event);
  const contextPayload = getRelevantContextMessages(context, relatedTopic).map((message) => ({
    sender_id: message.senderId,
    sender_name: message.senderName,
    text: message.text,
    mentions: message.mentions,
    create_time: new Date(message.createTime).toISOString(),
  }));
  const pending = getPendingActivity(event.chatId);
  const recent = getRecentActivity(event.chatId);
  const relevantPending = isPendingActivityFollowup(event, pending, event.text) ? pending : undefined;
  const relevantRecent = isRecentActivityFollowup(event, recent, event.text) ? recent : undefined;
  const memberPayload = members.map((member) => ({
    open_id: member.openId,
    name: member.name,
  }));

  const raw = await callStructuredLlm([
    {
      role: "system",
      content: [
        "你是 ProjectPilot 的 PM Orchestrator，总控群聊语义、同事式回复和工具调用时机，只输出 JSON 对象，不要输出解释。",
        "你的任务是依据 ProjectPilot Skill 判断 response_mode、tool_intent、assistant_reply，并为多人活动推荐可能参与人。",
        "Skill 是最高优先级业务规则；代码关键词只是粗略召回，不能限制你的语义判断。代码只负责门禁和工具安全，你负责语义判断。",
        "只能从候选群成员列表里选择 participant_candidates，不能凭空编人。",
        "json 输出必须带 grounding evidence。没有 grounding evidence 的工具动作必须降级为 chat 或 confirm_action。",
        "玩笑、辱骂、反讽、假设句不能触发工具；这些情况 safety_label 输出 joke/insult/hypothetical/ambiguous。",
        getProjectPilotSkill(),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        current_date: new Date().toISOString(),
        current_message: {
          message_id: event.messageId,
          sender_id: event.senderId,
          sender_name: event.senderName,
          text: event.text,
          mentions: event.mentions || [],
        },
        related_topic: relatedTopic
          ? {
              topic_id: relatedTopic.id,
              kind: relatedTopic.kind,
              status: relatedTopic.status,
              title: relatedTopic.title,
              evidence_texts: relatedTopic.evidenceTexts,
              message_ids: relatedTopic.messageIds,
              time_hint: relatedTopic.timeHint || "",
              location_hint: relatedTopic.locationHint || "",
            }
          : null,
        pending_activity: relevantPending
          ? {
              topic_id: relevantPending.topicId || "",
              title: relevantPending.title,
              time_hint: relevantPending.timeHint || "",
              location_hint: relevantPending.locationHint || "",
              participant_candidates: relevantPending.participantCandidates.map((participant) => ({
                open_id: participant.openId,
                name: participant.name,
              })),
              missing_fields: relevantPending.missingFields,
              source_text: relevantPending.sourceText,
            }
          : null,
        recent_activity: relevantRecent
          ? {
              topic_id: relevantRecent.topicId || "",
              title: relevantRecent.title,
              time_hint: relevantRecent.timeHint || "",
              location_hint: relevantRecent.locationHint || "",
              participant_candidates: relevantRecent.participantCandidates.map((participant) => ({
                open_id: participant.openId,
                name: participant.name,
              })),
              source_text: relevantRecent.sourceText,
              start: relevantRecent.start || "",
              end: relevantRecent.end || "",
              approximate: relevantRecent.approximate || false,
            }
          : null,
        recent_context: contextPayload,
        chat_members: memberPayload,
        member_lookup_incomplete: memberLookupIncomplete,
        output_schema: {
          response_mode: "silent | chat | suggest | confirm_action | execute_action",
          tool_intent:
            "none | calendar_create | calendar_update | task_create | project_intake | doc_update | risk_check",
          topic_action: "none | create_topic | update_topic | close_topic",
          topic_id: "existing related_topic.topic_id or empty",
          safety_label: "normal | joke | insult | hypothetical | ambiguous",
          intent:
            "explicit_schedule_create | social_schedule_candidate | cancel_or_change_candidate | project_request | ignore",
          confidence: "0..1",
          assistant_reply:
            "string; natural PM coworker reply for chat/suggest or a short question when information is missing",
          activity_title: "string or empty",
          time_hint: "string or empty",
          participant_candidates: [
            { open_id: "must be one of chat_members.open_id", name: "member name", reason: "short" },
          ],
          missing_fields: ["string"],
          grounding: {
            message_ids: ["current or related message ids used as evidence"],
            evidence_texts: ["short source text snippets proving the action"],
          },
          requires_confirmation: "boolean; true for collaborative writes like calendar/task/doc changes",
          should_ask_confirmation:
            "boolean; false means observe silently as a tentative candidate, true means send a confirmation card",
        },
      }),
    },
  ]);

  if (!raw) {
    return undefined;
  }

  const intent = normalizeIntent(raw.intent);
  const confidence = typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence || 0);
  const responseMode = normalizeResponseMode(
    getString(raw.response_mode) || getString(raw.responseMode) || defaultResponseMode(intent),
  );
  const toolIntent = normalizeToolIntent(
    getString(raw.tool_intent) || getString(raw.toolIntent) || defaultToolIntent(intent),
  );
  const topicAction = normalizeTopicAction(
    getString(raw.topic_action) || getString(raw.topicAction) || defaultTopicAction(intent),
  );
  const topicId = getString(raw.topic_id) || getString(raw.topicId) || relatedTopic?.id;
  const safetyLabel = normalizeSafetyLabel(
    getString(raw.safety_label) || getString(raw.safetyLabel) || detectSafetyLabel(event),
  );
  const grounding = normalizeGrounding(raw.grounding, event);
  const assistantReply = getString(raw.assistant_reply) || getString(raw.assistantReply);
  const participantCandidates = filterParticipantCandidates(raw.participant_candidates, members);
  const activityTitle = getString(raw.activity_title) || getString(raw.activityTitle);
  const timeHint = getString(raw.time_hint) || getString(raw.timeHint);
  const missingFields =
    normalizeStringArray(raw.missing_fields).length > 0
      ? normalizeStringArray(raw.missing_fields)
      : normalizeStringArray(raw.missingFields);
  const shouldAskConfirmation =
    typeof raw.should_ask_confirmation === "boolean"
      ? raw.should_ask_confirmation
      : raw.shouldAskConfirmation === true;
  const requiresConfirmation =
    typeof raw.requires_confirmation === "boolean"
      ? raw.requires_confirmation
      : raw.requiresConfirmation === true || shouldAskConfirmation;

  return {
    intent,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    responseMode,
    toolIntent,
    topicAction,
    topicId,
    grounding,
    safetyLabel,
    assistantReply,
    activityTitle,
    timeHint,
    participantCandidates,
    missingFields,
    shouldAskConfirmation,
    requiresConfirmation,
    memberLookupIncomplete,
  } satisfies IntentDecision;
}

function classifyHeuristically(
  event: NormalizedMessageEvent,
  context: ChatContext,
  members: ChatMember[],
  memberLookupIncomplete: boolean,
): IntentDecision {
  const text = event.text;
  let intent: IntentKind = "ignore";
  const pending = getPendingActivity(event.chatId);
  const recent = getRecentActivity(event.chatId);

  if (pending && isPendingActivityFollowup(event, pending, text) && (isCancelExpression(text) || isParticipantAdjustment(text))) {
    intent = "cancel_or_change_candidate";
  } else if (isRecentActivityFollowup(event, recent, text)) {
    intent = "cancel_or_change_candidate";
  } else if (isSocialScheduleCandidate(text)) {
    intent = "social_schedule_candidate";
  } else if (isCalendarCreateIntent(text)) {
    intent = "explicit_schedule_create";
  } else if (isProjectIntent(text)) {
    intent = "project_request";
  }

  const timeHint = inferTimeHint(text);
  const participantCandidates = fallbackParticipantCandidates(event, context, members);
  return {
    intent,
    confidence: intent === "ignore" ? 0 : 0.72,
    responseMode: defaultResponseMode(intent),
    toolIntent: defaultToolIntent(intent),
    topicAction: defaultTopicAction(intent),
    grounding: defaultGrounding(event),
    safetyLabel: detectSafetyLabel(event),
    activityTitle: normalizeActivityTitle(undefined, text),
    timeHint,
    participantCandidates,
    missingFields: timeHint && hasExplicitCalendarTime(text) ? [] : ["具体时间"],
    shouldAskConfirmation: intent === "social_schedule_candidate",
    requiresConfirmation: intent === "social_schedule_candidate",
    memberLookupIncomplete,
  };
}

function shouldConsultModel(
  event: NormalizedMessageEvent,
  context: ChatContext,
  fallback: IntentDecision,
) {
  if (isDirectMention(event) || isPrivateChat(event)) {
    return true;
  }

  if (fallback.intent !== "ignore") {
    return true;
  }

  const pending = getPendingActivity(event.chatId);
  const tentative = getTentativeActivity(event.chatId);
  if (
    isPendingActivityFollowup(event, pending, event.text) ||
    isTentativeActivityFollowup(event, tentative, event.text)
  ) {
    return true;
  }

  const recent = getRecentActivity(event.chatId);
  if (isRecentActivityFollowup(event, recent, event.text)) {
    return true;
  }

  if (hasConstructiveWorkCue(event.text)) {
    return true;
  }

  return Boolean(context.chatId && hasModelRoutingCue(event));
}

async function classifyIntent(
  event: NormalizedMessageEvent,
  context: ChatContext,
): Promise<IntentDecision> {
  const lightweightFallback = classifyHeuristically(event, context, [], false);
  if (!shouldConsultModel(event, context, lightweightFallback)) {
    return lightweightFallback;
  }

  const { members, incomplete } =
    event.chatId && !isPrivateChat(event)
      ? await getChatMembers(event.chatId, context, event)
      : { members: fallbackMembersFromContext(context, event), incomplete: false };

  const fallback = classifyHeuristically(event, context, members, incomplete);
  try {
    const modelDecision = await classifyWithModel(event, context, members, incomplete);
    if (
      modelDecision &&
      modelDecision.confidence >= 0.55 &&
      (modelDecision.intent !== "ignore" || modelDecision.responseMode !== "silent")
    ) {
      const inferredParticipants = inferParticipantCandidatesFromMembers(event, context, members);
      if (modelDecision.toolIntent !== "none" && !modelDecision.participantCandidates.length) {
        modelDecision.participantCandidates = fallback.participantCandidates;
      }
      if (
        inferredParticipants.length &&
        modelDecision.toolIntent !== "none" &&
        (mentionsCollectiveOrPronoun(event.text) || modelDecision.participantCandidates.length <= 1)
      ) {
        modelDecision.participantCandidates = uniqueByOpenId([
          ...modelDecision.participantCandidates,
          ...inferredParticipants,
        ]);
      }
      if (!modelDecision.activityTitle) {
        modelDecision.activityTitle = fallback.activityTitle;
      }
      if (modelDecision.toolIntent !== "none") {
        modelDecision.activityTitle = normalizeActivityTitle(modelDecision.activityTitle, event.text);
      }
      if (!modelDecision.timeHint) {
        modelDecision.timeHint = fallback.timeHint;
      }
      if (modelDecision.toolIntent !== "none" && !modelDecision.missingFields.length) {
        modelDecision.missingFields = fallback.missingFields;
      }
      return modelDecision;
    }
  } catch (error) {
    console.error("结构化意图判断失败，使用启发式结果:", error);
  }

  return fallback;
}

function isCalendarCreateIntent(text: string) {
  return /(创建|新建|安排|预约|约|添加).{0,12}(日程|日历|会议|会)/i.test(text);
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function parseChineseNumber(value: string) {
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (value === "十") {
    return 10;
  }

  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    const tenValue = tens ? digits[tens] || 0 : 1;
    const oneValue = ones ? digits[ones] || 0 : 0;
    return tenValue * 10 + oneValue;
  }

  return digits[value];
}

function normalizeChineseTimeText(text: string) {
  return text.replace(/([一二两三四五六七八九十]{1,3})(点|:|：)/g, (match, hour, suffix) => {
    const parsed = parseChineseNumber(hour);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 24) {
      return match;
    }

    return `${parsed}${suffix}`;
  });
}

function toLocalIso(date: Date) {
  return [
    date.getFullYear(),
    "-",
    pad2(date.getMonth() + 1),
    "-",
    pad2(date.getDate()),
    "T",
    pad2(date.getHours()),
    ":",
    pad2(date.getMinutes()),
    CHINA_TZ_OFFSET,
  ].join("");
}

function formatCalendarIsoForHumans(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) {
    return value;
  }

  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

function formatCalendarTimeRange(intent: CalendarIntent) {
  const start = formatCalendarIsoForHumans(intent.start);
  const end = formatCalendarIsoForHumans(intent.end);
  const startDate = start.slice(0, 10);
  const endDate = end.slice(0, 10);
  if (startDate === endDate) {
    return `${start} - ${end.slice(11)}`;
  }

  return `${start} - ${end}`;
}

function normalizeHour(hour: number, period?: string) {
  if (!period) {
    return hour;
  }

  if ((period.includes("下午") || period.includes("晚上") || period.includes("今晚")) && hour < 12) {
    return hour + 12;
  }

  if (period.includes("中午") && hour < 11) {
    return hour + 12;
  }

  return hour;
}

function weekdayIndex(value: string) {
  const map: Record<string, number> = {
    日: 0,
    天: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
  };
  return map[value];
}

function resolveWeekdayDate(text: string, now = new Date()) {
  const match = text.match(/(?:(这周|本周|下周|下个周|下星期|下礼拜))?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (!match) {
    return undefined;
  }

  const target = weekdayIndex(match[2]);
  if (!Number.isFinite(target)) {
    return undefined;
  }

  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const current = base.getDay();
  let diff = target - current;
  const explicitNext = /下/.test(match[1] || "");
  if (explicitNext) {
    diff += diff <= 0 ? 7 : 7;
  } else if (!match[1] && diff < 0) {
    diff += 7;
  }
  base.setDate(base.getDate() + diff);
  return base;
}

function hasCalendarDateHint(text: string) {
  return /(今天|今日|明天|明日|后天|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日?)/.test(
    text,
  );
}

function resolveBaseDate(text: string, now = new Date()) {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);

  if (text.includes("后天")) {
    base.setDate(base.getDate() + 2);
    return base;
  }

  if (text.includes("明天") || text.includes("明日")) {
    base.setDate(base.getDate() + 1);
    return base;
  }

  const fullDate = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/);
  if (fullDate) {
    return new Date(Number(fullDate[1]), Number(fullDate[2]) - 1, Number(fullDate[3]));
  }

  const monthDate = text.match(/(\d{1,2})月(\d{1,2})日?/);
  if (monthDate) {
    return new Date(now.getFullYear(), Number(monthDate[1]) - 1, Number(monthDate[2]));
  }

  const weekdayDate = resolveWeekdayDate(text, now);
  if (weekdayDate) {
    return weekdayDate;
  }

  return base;
}

function parseDurationMinutes(text: string) {
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(小时|h)/i);
  if (hourMatch) {
    return Math.round(Number(hourMatch[1]) * 60);
  }

  const minuteMatch = text.match(/(\d+)\s*(分钟|分|min)/i);
  if (minuteMatch) {
    return Number(minuteMatch[1]);
  }

  return DEFAULT_EVENT_DURATION_MINUTES;
}

function extractSummary(text: string) {
  const quoted = text.match(/[「“"]([^」”"]{2,60})[」”"]/);
  if (quoted) {
    return quoted[1].trim();
  }

  const titled = text.match(/(?:标题|主题|名称)[:：\s]+([^，,。；;\n]{2,60})/);
  if (titled) {
    return titled[1].trim();
  }

  const cleaned = text
    .replace(/(今天|今日|明天|明日|后天)/g, "")
    .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g, "")
    .replace(/\d{1,2}月\d{1,2}日?/g, "")
    .replace(/(上午|早上|中午|下午|晚上|今晚)?\s*\d{1,2}([:：点]\d{0,2})?\s*(分)?\s*(到|至|-|~|—)\s*(上午|早上|中午|下午|晚上)?\s*\d{1,2}([:：点]\d{0,2})?\s*(分)?/g, "")
    .replace(/(上午|早上|中午|下午|晚上|今晚)?\s*\d{1,2}([:：点]\d{0,2})?\s*(分)?/g, "")
    .replace(/\d+(?:\.\d+)?\s*(小时|h|分钟|分|min)/gi, "")
    .replace(/(帮我|帮我们|请|麻烦|创建|新建|安排|预约|约一个|约个|约|日程|日历|会议|开会)/g, "")
    .replace(/[，,。；;：:]/g, " ")
    .trim();

  return cleaned || "会议";
}

function parseCalendarIntent(text: string, now = new Date()): CalendarIntent | undefined {
  const normalizedText = normalizeChineseTimeText(text);
  if (!isCalendarCreateIntent(normalizedText)) {
    return undefined;
  }

  const rangeMatch = normalizedText.match(
    /(上午|早上|中午|下午|晚上|今晚)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)?\s*(?:分)?\s*(?:到|至|-|~|—)\s*(上午|早上|中午|下午|晚上)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)?\s*(?:分)?/,
  );
  const singleMatch = normalizedText.match(/(上午|早上|中午|下午|晚上|今晚)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)\s*(?:分)?/);

  if (!rangeMatch && !singleMatch) {
    throw new Error("missing_explicit_time");
  }

  const baseDate = resolveBaseDate(normalizedText, now);
  const period = rangeMatch?.[1] || singleMatch?.[1];
  const startHour = normalizeHour(Number(rangeMatch?.[2] || singleMatch?.[2]), period);
  const startMinute = Number(rangeMatch?.[3] || singleMatch?.[3] || 0);
  const start = new Date(baseDate);
  start.setHours(startHour, startMinute, 0, 0);

  let end: Date;
  if (rangeMatch) {
    const endPeriod = rangeMatch[4] || period;
    const endHour = normalizeHour(Number(rangeMatch[5]), endPeriod);
    const endMinute = Number(rangeMatch[6] || 0);
    end = new Date(baseDate);
    end.setHours(endHour, endMinute, 0, 0);
    if (end <= start) {
      end.setDate(end.getDate() + 1);
    }
  } else {
    end = new Date(start.getTime() + parseDurationMinutes(normalizedText) * 60_000);
  }

  if (!hasCalendarDateHint(normalizedText) && start <= now) {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 1);
  }

  return {
    summary: extractSummary(text),
    start: toLocalIso(start),
    end: toLocalIso(end),
  };
}

function parseApproximateCalendarIntent(text: string, now = new Date()): CalendarIntent | undefined {
  const normalizedText = normalizeChineseTimeText(text);
  if (!isCalendarCreateIntent(normalizedText)) {
    return undefined;
  }

  if (!hasCalendarDateHint(normalizedText)) {
    return undefined;
  }

  const baseDate = resolveBaseDate(normalizedText, now);
  const ranges: Array<[RegExp, number, number, string]> = [
    [/(早上|上午)/, 9, 12, "上午"],
    [/中午/, 12, 14, "中午"],
    [/下午/, 14, 18, "下午"],
    [/(晚上|今晚|明晚)/, 19, 21, "晚上"],
  ];
  const matchedRange = ranges.find(([pattern]) => pattern.test(normalizedText));
  const [, startHour, endHour, label] = matchedRange || [/./, 9, 18, "当天"];
  const start = new Date(baseDate);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(baseDate);
  end.setHours(endHour, 0, 0, 0);

  if (end <= start) {
    end.setDate(end.getDate() + 1);
  }
  if (end <= now) {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 1);
  }

  return {
    summary: extractSummary(text),
    start: toLocalIso(start),
    end: toLocalIso(end),
    approximate: true,
    approximateLabel: inferTimeHint(text) || label,
  };
}

function formatCalendarResult(intent: CalendarIntent) {
  if (intent.approximate) {
    return [
      `安排上了：${intent.summary}`,
      `我先按「${intent.approximateLabel || "大概时间"}」放进日历：${formatCalendarTimeRange(intent)}`,
      "如果想更准，直接回我「改到明天下午5点」就行。",
    ].join("\n");
  }

  return [`安排好了：${intent.summary}`, `时间：${formatCalendarTimeRange(intent)}`].join("\n");
}

function getCalendarReply(result: string | CalendarCreateResult | undefined) {
  return typeof result === "string" ? result : result?.reply;
}

function isCalendarCreateSuccess(result: string | CalendarCreateResult | undefined) {
  return /^安排[上好]了/.test(getCalendarReply(result) || "");
}

function toUnixSeconds(value: string) {
  return String(Math.floor(new Date(value).getTime() / 1000));
}

function extractCalendarCreateIds(result: unknown) {
  const calendarId =
    findStringDeep(result, ["calendar_id", "calendarId", "organizer_calendar_id", "organizerCalendarId"]) ||
    "primary";
  const eventId = findStringDeep(result, ["event_id", "eventId"]);
  return { calendarId, eventId };
}

function sanitizeError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(app_secret|access_token|refresh_token|Authorization)["':=\s]+[^"',\s}]+/gi, "$1=***")
    .slice(0, 700);
}

async function createCalendarEventFromText(
  text: string,
  attendeeIds: string[] = [],
  options: { allowApproximate?: boolean } = {},
): Promise<CalendarCreateResult | undefined> {
  let intent: CalendarIntent | undefined;
  try {
    intent = parseCalendarIntent(text);
  } catch (error) {
    if (error instanceof Error && error.message === "missing_explicit_time") {
      if (options.allowApproximate) {
        intent = parseApproximateCalendarIntent(text);
      }
      if (!intent) {
        return {
          reply: "我可以先安排，但还缺一个大概时间。比如直接说：明天下午、明晚，或明天下午5点。",
        };
      }
    } else {
      throw error;
    }
  }

  if (!intent) {
    return undefined;
  }

  try {
    const args = [
      "calendar",
      "+create",
      "--summary",
      intent.summary,
      "--start",
      intent.start,
      "--end",
      intent.end,
      "--description",
      `由 ProjectPilot 从群聊指令创建：${text}`,
    ];
    if (attendeeIds.length) {
      args.push("--attendee-ids", attendeeIds.join(","));
    }

    const raw = await runLarkCli(args, "user");
    const { calendarId, eventId } = extractCalendarCreateIds(raw);
    return {
      reply: formatCalendarResult(intent),
      intent,
      calendarId,
      eventId,
      raw,
    };
  } catch (error) {
    console.error("创建日程失败:", error);
    return {
      reply: `我收到了创建日程请求，但飞书日历创建失败：${sanitizeError(error)}`,
    };
  }
}

function normalizeEvent(raw: IncomingMessageEvent): NormalizedMessageEvent | undefined {
  const type = raw.type || raw.header?.event_type;
  if (type !== MESSAGE_EVENT_TYPE) {
    return undefined;
  }

  const message = raw.event?.message;
  const sender = raw.event?.sender;

  return {
    type,
    messageId: raw.message_id || raw.id || message?.message_id,
    chatId: raw.chat_id || message?.chat_id,
    chatType: raw.chat_type || message?.chat_type,
    senderId: raw.sender_id || sender?.sender_id?.open_id,
    senderName: sender?.name,
    messageType: raw.message_type || message?.message_type,
    senderType: sender?.sender_type || "user",
    mentions: normalizeMentions(raw.mentions || message?.mentions),
    createTime: parseEventTime(raw.create_time || message?.create_time),
    text: normalizeContent(raw.content ?? message?.content),
  };
}

function safeJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function stringifyForDebug(value: unknown) {
  try {
    return JSON.stringify(value).slice(0, 2_000);
  } catch {
    return String(value).slice(0, 2_000);
  }
}

function findStringDeep(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const parsed = safeJsonObject(value);
    return parsed ? findStringDeep(parsed, keys, depth + 1) : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringDeep(item, keys, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }

  for (const raw of Object.values(record)) {
    const found = findStringDeep(raw, keys, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function findCardActionDeep(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    if (KNOWN_CARD_ACTIONS.has(value)) {
      return value;
    }

    const parsed = safeJsonObject(value);
    return parsed ? findCardActionDeep(parsed, depth + 1) : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCardActionDeep(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const directAction = getString(record.action) || getString(record.action_id);
  if (directAction && KNOWN_CARD_ACTIONS.has(directAction)) {
    return directAction;
  }

  for (const raw of Object.values(record)) {
    const found = findCardActionDeep(raw, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function normalizeCardAction(raw: IncomingMessageEvent): CardActionEvent | undefined {
  const type = raw.type || raw.header?.event_type;
  if (type !== CARD_ACTION_EVENT_TYPE) {
    return undefined;
  }

  const actionValue = raw.event?.action?.value;
  const value =
    typeof actionValue === "string"
      ? safeJsonObject(actionValue) || {}
      : actionValue && typeof actionValue === "object"
        ? (actionValue as Record<string, unknown>)
        : {};
  const rawRecord = raw as Record<string, unknown>;
  const action = getString(value.action) || findCardActionDeep(raw);
  const candidateId =
    getString(value.candidate_id) ||
    getString(value.candidateId) ||
    findStringDeep(raw, ["candidate_id", "candidateId"]);

  return {
    type,
    action,
    candidateId,
    chatId:
      raw.event?.context?.open_chat_id ||
      getString(rawRecord.open_chat_id) ||
      findStringDeep(raw, ["open_chat_id", "chat_id"]) ||
      raw.chat_id,
    messageId:
      raw.event?.context?.open_message_id ||
      getString(rawRecord.open_message_id) ||
      findStringDeep(raw, ["open_message_id", "message_id"]) ||
      raw.message_id,
    operatorId:
      raw.event?.operator?.open_id ||
      raw.event?.operator?.user_id ||
      getString(rawRecord.operator_id) ||
      getString(rawRecord.open_id) ||
      findStringDeep(raw, ["operator_id", "open_id", "user_id"]) ||
      raw.sender_id,
  };
}

function eventFromCardAction(cardEvent: CardActionEvent, text: string): NormalizedMessageEvent {
  return {
    type: CARD_ACTION_EVENT_TYPE,
    chatId: cardEvent.chatId,
    messageId: cardEvent.messageId,
    senderId: cardEvent.operatorId,
    senderType: "user",
    messageType: "interactive",
    text,
  };
}

function getPendingByCardAction(cardEvent: CardActionEvent) {
  const byChat = getPendingActivity(cardEvent.chatId);
  if (!cardEvent.candidateId || byChat?.id === cardEvent.candidateId) {
    return byChat;
  }

  for (const pending of pendingActivities.values()) {
    if (pending.id === cardEvent.candidateId) {
      return pending;
    }
  }

  return undefined;
}

async function handleCardAction(raw: IncomingMessageEvent) {
  let cardEvent: CardActionEvent | undefined;
  try {
    cardEvent = normalizeCardAction(raw);
  } catch (error) {
    console.error("解析卡片回调失败:", error);
    return;
  }

  if (!cardEvent) {
    return;
  }

  console.log(
    `收到卡片回调: action=${cardEvent.action || "(none)"} candidate=${cardEvent.candidateId || "(none)"}`,
  );
  if (!cardEvent.action || !cardEvent.candidateId) {
    console.warn("卡片回调字段未完整解析，原始事件片段:", stringifyForDebug(raw));
  }

  const pending = getPendingByCardAction(cardEvent);
  if (!pending) {
    if (cardEvent.chatId || cardEvent.messageId) {
      await sendMessage(
        eventFromCardAction(cardEvent, "expired"),
        "这个候选安排已经失效了。可以重新在群里说一下要安排的活动。",
      );
    }
    return;
  }

  if (cardEvent.action === "create_schedule") {
    const result = await confirmPendingCreate(pending);
    if (isCalendarCreateSuccess(result) && cardEvent.messageId) {
      attachRecentActivityCardMessage(pending.chatId, cardEvent.messageId);
      try {
        await updateInteractiveMessage(cardEvent.messageId, buildCreatedActivityCard(pending, result));
        return;
      } catch (error) {
        console.warn("更新已创建卡片失败，降级为文本回复:", sanitizeError(error));
      }
    }

    await sendMessage(eventFromCardAction(cardEvent, "确认创建"), result);
    return;
  }

  if (cardEvent.action === "adjust_participants") {
    await sendMessage(
      eventFromCardAction(cardEvent, "调整参与人"),
      "可以直接回复：加上某某，或去掉某某。我会更新建议参与人后再等你确认创建。",
    );
    return;
  }

  if (cardEvent.action === "dismiss_candidate" || cardEvent.action === "cancel_candidate") {
    pendingActivities.delete(pending.chatId);
    await sendMessage(
      eventFromCardAction(cardEvent, "取消候选"),
      `已取消候选安排：${pending.title}。`,
    );
    return;
  }

  if (cardEvent.action === "keep_candidate") {
    pending.status = "pending";
    pendingActivities.set(pending.chatId, pending);
    await sendMessage(
      eventFromCardAction(cardEvent, "保留候选"),
      `好的，先保留候选安排：${pending.title}。`,
    );
  }
}

function formatParticipantNames(participants: ParticipantCandidate[]) {
  if (!participants.length) {
    return "暂不确定";
  }

  return participants.map((participant) => participant.name).join("、");
}

function createPendingId(event: NormalizedMessageEvent) {
  return [event.chatId || "chat", event.messageId || Date.now().toString(36)].join(":");
}

function buildActivityFallbackText(pending: PendingActivity) {
  const participantText = formatParticipantNames(pending.participantCandidates);
  const missingText = pending.missingFields.length
    ? `\n缺少信息：${pending.missingFields.join("、")}`
    : "";
  const memberNote = pending.memberLookupIncomplete
    ? "\n注：我暂时没读到完整群成员，只按最近发言和 @ 提及推荐。"
    : "";

  return [
    "我看起来像是在约一个多人安排，要不要先创建日程？",
    `活动：${pending.title}`,
    `时间：${pending.timeHint || "待补充"}`,
    pending.locationHint ? `地点：${pending.locationHint}` : "",
    `建议参与人：${participantText}`,
    missingText,
    memberNote,
    "可以回复：确认创建 / 加上某某 / 先不创建。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildActivityCard(pending: PendingActivity): Record<string, unknown> {
  const participantText = formatParticipantNames(pending.participantCandidates);
  const uncertainty = pending.participantCandidates.length
    ? ""
    : "\n\n我还不确定参与人，是否只先创建给发起人？";
  const missingText = pending.missingFields.length
    ? `\n**待补充**：${pending.missingFields.join("、")}`
    : "";
  const memberNote = pending.memberLookupIncomplete
    ? "\n\n_我暂时没读到完整群成员，只按最近发言和 @ 提及推荐。_"
    : "";

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "要创建这个日程吗？" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**活动**：${pending.title}`,
            `**时间**：${pending.timeHint || "待补充"}`,
            pending.locationHint ? `**地点**：${pending.locationHint}` : "",
            `**建议参与人**：${participantText}`,
            missingText,
            uncertainty,
            memberNote,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "创建日程" },
            type: "primary",
            value: { action: "create_schedule", candidate_id: pending.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "调整参与人" },
            value: { action: "adjust_participants", candidate_id: pending.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "先不创建" },
            value: { action: "dismiss_candidate", candidate_id: pending.id },
          },
        ],
      },
    ],
  };
}

function buildCreatedActivityCard(
  pending: PendingActivity,
  result: string,
): Record<string, unknown> {
  const participantText = formatParticipantNames(pending.participantCandidates);
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "已创建日程" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "**状态**：已创建",
            `**活动**：${pending.title}`,
            pending.locationHint ? `**地点**：${pending.locationHint}` : "",
            `**参与人**：${participantText}`,
            "",
            result,
          ]
            .filter((line) => line !== undefined)
            .join("\n"),
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "需要微调时间的话，直接回复“改到明天下午5点”。",
          },
        ],
      },
    ],
  };
}

function buildCancelFallbackText(pending: PendingActivity) {
  return [
    "你是想取消这个候选安排吗？",
    `活动：${pending.title}`,
    `时间：${pending.timeHint || "待补充"}`,
    "可以回复：确认取消 / 保留。",
  ].join("\n");
}

function buildCancelCard(pending: PendingActivity): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "要取消这个候选安排吗？" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**活动**：${pending.title}`,
            `**时间**：${pending.timeHint || "待补充"}`,
            pending.locationHint ? `**地点**：${pending.locationHint}` : "",
          ].join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "取消候选" },
            type: "primary",
            value: { action: "cancel_candidate", candidate_id: pending.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "保留" },
            value: { action: "keep_candidate", candidate_id: pending.id },
          },
        ],
      },
    ],
  };
}

function createPendingActivity(event: NormalizedMessageEvent, decision: IntentDecision) {
  if (!event.chatId) {
    throw new Error("缺少 chat_id，无法保存候选活动");
  }

  const pending: PendingActivity = {
    id: createPendingId(event),
    topicId: decision.topicId,
    chatId: event.chatId,
    sourceText: event.text,
    sourceMessageId: event.messageId,
    sourceSenderId: event.senderId,
    createdAt: Date.now(),
    title: normalizeActivityTitle(decision.activityTitle, event.text),
    timeHint: decision.timeHint || inferTimeHint(event.text),
    locationHint: extractLocationHint(event.text),
    participantCandidates: decision.participantCandidates,
    missingFields: decision.missingFields.length
      ? decision.missingFields
      : hasExplicitCalendarTime(event.text)
        ? []
        : ["具体时间"],
    memberLookupIncomplete: decision.memberLookupIncomplete,
    status: "pending",
  };
  const topic = createOrUpdateTopicFromActivity(event, pending, "confirming");
  pending.topicId = topic.id;
  pendingActivities.set(event.chatId, pending);
  return pending;
}

async function applyParticipantAdjustment(
  event: NormalizedMessageEvent,
  context: ChatContext,
  pending: PendingActivity,
) {
  if (!event.chatId) {
    return "我需要在群聊里才能调整这个候选安排的参与人。";
  }

  const { members, incomplete } = await getChatMembers(event.chatId, context, event);
  if (isCollectiveParticipantRequest(event.text)) {
    const groupMembers = members
      .filter((member) => !isBotLikeMember(member))
      .slice(0, 30)
      .map((member) => ({
        openId: member.openId,
        name: member.name,
        reason: "用户要求群里全部人参与",
      }));

    if (!groupMembers.length) {
      return "我现在读不到可加入的群成员。你可以直接说：加上张三、李四，我再更新参与人。";
    }

    pending.participantCandidates = uniqueByOpenId(groupMembers);
    pending.memberLookupIncomplete = incomplete;
    pending.topicId = createOrUpdateTopicFromActivity(event, pending, "confirming").id;
    pendingActivities.set(pending.chatId, pending);
    const note = incomplete ? "（我没读到完整群成员，先按上下文可见成员处理）" : "";
    return `已把建议参与人改为群里全部成员：${formatParticipantNames(pending.participantCandidates)}${note}。回复「确认创建」或补充时间后我再创建日程。`;
  }

  const matched = members.filter((member) => event.text.includes(member.name));
  if (!matched.length) {
    return "我还没识别出要调整的成员。可以直接说：加上张三、去掉李四，或说“群里的全部人”。";
  }

  const removing = /(去掉|别拉|不用拉|不带)/.test(event.text);
  if (removing) {
    const removeIds = new Set(matched.map((member) => member.openId));
    pending.participantCandidates = pending.participantCandidates.filter(
      (candidate) => !removeIds.has(candidate.openId),
    );
  } else {
    pending.participantCandidates = uniqueByOpenId([
      ...pending.participantCandidates,
      ...matched.map((member) => ({
        openId: member.openId,
        name: member.name,
        reason: "用户文本补充",
      })),
    ]);
  }

  pending.topicId = createOrUpdateTopicFromActivity(event, pending, "confirming").id;
  pendingActivities.set(pending.chatId, pending);
  return `已更新建议参与人：${formatParticipantNames(pending.participantCandidates)}。回复「确认创建」后我再创建日程。`;
}

async function applyModelPendingUpdate(pending: PendingActivity, decision: IntentDecision) {
  let changed = false;

  if (decision.participantCandidates.length) {
    pending.participantCandidates = uniqueByOpenId(decision.participantCandidates);
    pending.memberLookupIncomplete = decision.memberLookupIncomplete;
    changed = true;
  }

  if (decision.timeHint) {
    pending.timeHint = decision.timeHint;
    pending.missingFields = pending.missingFields.filter((field) => !field.includes("时间"));
    changed = true;
  }

  if (!changed) {
    return undefined;
  }

  const topic = createOrUpdateTopicFromActivity(
    {
      type: MESSAGE_EVENT_TYPE,
      chatId: pending.chatId,
      messageId: pending.sourceMessageId,
      senderId: pending.sourceSenderId,
      text: pending.sourceText,
    },
    pending,
    "confirming",
  );
  pending.topicId = topic.id;
  pendingActivities.set(pending.chatId, pending);
  const pieces = ["已更新候选安排。"];
  if (decision.timeHint) {
    pieces.push(`时间：${pending.timeHint}`);
  }
  if (decision.participantCandidates.length) {
    pieces.push(`建议参与人：${formatParticipantNames(pending.participantCandidates)}`);
  }
  pieces.push("确认没问题后，回复「确认创建」就行。");
  return pieces.join("\n");
}

function rememberRecentActivityFromPending(pending: PendingActivity, result: CalendarCreateResult) {
  if (!isCalendarCreateSuccess(result)) {
    return undefined;
  }

  const recent: RecentActivity = {
    id: pending.id,
    topicId: pending.topicId,
    chatId: pending.chatId,
    sourceText: pending.sourceText,
    sourceMessageId: pending.sourceMessageId,
    sourceSenderId: pending.sourceSenderId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: pending.title,
    timeHint: pending.timeHint || result.intent?.approximateLabel,
    locationHint: pending.locationHint,
    participantCandidates: pending.participantCandidates,
    memberLookupIncomplete: pending.memberLookupIncomplete,
    calendarId: result.calendarId,
    eventId: result.eventId,
    start: result.intent?.start,
    end: result.intent?.end,
    approximate: result.intent?.approximate,
  };
  const topic = createOrUpdateTopicFromActivity(
    {
      type: MESSAGE_EVENT_TYPE,
      chatId: pending.chatId,
      messageId: pending.sourceMessageId,
      senderId: pending.sourceSenderId,
      text: pending.sourceText,
    },
    recent,
    "committed",
  );
  recent.topicId = topic.id;
  setRecentActivity(recent);
  return recent;
}

function rememberRecentActivityFromEvent(
  event: NormalizedMessageEvent,
  decision: IntentDecision,
  result: CalendarCreateResult,
) {
  if (!event.chatId || !isCalendarCreateSuccess(result)) {
    return undefined;
  }

  const recent: RecentActivity = {
    id: createPendingId(event),
    topicId: decision.topicId,
    chatId: event.chatId,
    sourceText: event.text,
    sourceMessageId: event.messageId,
    sourceSenderId: event.senderId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: result.intent?.summary || normalizeActivityTitle(decision.activityTitle, event.text),
    timeHint: decision.timeHint || inferTimeHint(event.text) || result.intent?.approximateLabel,
    locationHint: extractLocationHint(event.text),
    participantCandidates: decision.participantCandidates,
    memberLookupIncomplete: decision.memberLookupIncomplete,
    calendarId: result.calendarId,
    eventId: result.eventId,
    start: result.intent?.start,
    end: result.intent?.end,
    approximate: result.intent?.approximate,
  };
  const topic = createOrUpdateTopicFromActivity(event, recent, "committed");
  recent.topicId = topic.id;
  setRecentActivity(recent);
  return recent;
}

function attachRecentActivityCardMessage(chatId?: string, cardMessageId?: string) {
  const recent = getRecentActivity(chatId);
  if (!recent || !cardMessageId) {
    return;
  }

  recent.cardMessageId = cardMessageId;
  recent.updatedAt = Date.now();
  setRecentActivity(recent);
}

function hasDateHint(text: string) {
  return hasCalendarDateHint(text);
}

function dateHintFromIso(value?: string) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function buildRecentActivityCalendarText(
  recent: RecentActivity,
  decision: IntentDecision,
  text: string,
) {
  const timeHint = decision.timeHint || inferTimeHint(text) || text;
  const dateHint = hasDateHint(timeHint) ? "" : dateHintFromIso(recent.start);
  return `创建日程「${recent.title}」 ${dateHint} ${timeHint}`.trim();
}

function pendingActivityFromRecent(recent: RecentActivity): PendingActivity {
  return {
    id: recent.id,
    topicId: recent.topicId,
    chatId: recent.chatId,
    sourceText: recent.sourceText,
    sourceMessageId: recent.sourceMessageId,
    sourceSenderId: recent.sourceSenderId,
    createdAt: recent.createdAt,
    title: recent.title,
    timeHint: recent.timeHint,
    locationHint: recent.locationHint,
    participantCandidates: recent.participantCandidates,
    missingFields: [],
    memberLookupIncomplete: recent.memberLookupIncomplete,
    status: "pending",
  };
}

function findCalendarEventRecord(
  value: unknown,
  title: string,
  depth = 0,
): { calendarId?: string; eventId?: string } | undefined {
  if (depth > 8 || value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const parsed = safeJsonObject(value);
    return parsed ? findCalendarEventRecord(parsed, title, depth + 1) : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCalendarEventRecord(item, title, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const eventId = getString(record.event_id) || getString(record.eventId);
  const calendarId =
    getString(record.calendar_id) ||
    getString(record.calendarId) ||
    getString(record.organizer_calendar_id) ||
    getString(record.organizerCalendarId);
  const summary = getString(record.summary) || getString(record.title) || getString(record.name);
  if (eventId && (!summary || summary.includes(title) || title.includes(summary))) {
    return { calendarId, eventId };
  }

  for (const raw of Object.values(record)) {
    const found = findCalendarEventRecord(raw, title, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

async function hydrateRecentCalendarIds(recent: RecentActivity) {
  if (recent.eventId || !recent.start || !recent.end) {
    return;
  }

  try {
    const agenda = await runLarkCli(
      [
        "calendar",
        "+agenda",
        "--calendar-id",
        recent.calendarId || "primary",
        "--start",
        recent.start,
        "--end",
        recent.end,
        "--format",
        "json",
      ],
      "user",
    );
    const found = findCalendarEventRecord(agenda, recent.title);
    if (found?.eventId) {
      recent.eventId = found.eventId;
      recent.calendarId = found.calendarId || recent.calendarId || "primary";
      setRecentActivity(recent);
    }
  } catch (error) {
    console.warn("回查最近日程 ID 失败:", sanitizeError(error));
  }
}

async function patchRecentCalendarEventFields(
  recent: RecentActivity,
  data: Record<string, unknown>,
) {
  await hydrateRecentCalendarIds(recent);

  if (!recent.eventId) {
    return "我理解你想改这个日程，但刚才创建返回里没有拿到 event_id，暂时没法安全定位到要更新的日程。你可以先在日历卡片里手动改一下时间。";
  }

  await runLarkCli(
    [
      "calendar",
      "events",
      "patch",
      "--params",
      JSON.stringify({
        calendar_id: recent.calendarId || "primary",
        event_id: recent.eventId,
        user_id_type: "open_id",
      }),
      "--data",
      JSON.stringify({
        ...data,
        need_notification: true,
      }),
    ],
    "user",
  );

  return undefined;
}

function getRecentActivityTitleUpdate(
  event: NormalizedMessageEvent,
  decision: IntentDecision,
  recent: RecentActivity,
) {
  if (!/(?:改|换|不.*了|别.*了|不要.*了)/.test(event.text)) {
    return undefined;
  }

  const nextTitle = normalizeActivityTitle(decision.activityTitle, event.text);
  if (nextTitle && nextTitle !== recent.title) {
    return nextTitle;
  }

  return undefined;
}

async function applyRecentActivityUpdate(
  event: NormalizedMessageEvent,
  decision: IntentDecision,
  recent: RecentActivity,
) {
  const wantsTimeChange = Boolean(decision.timeHint || isTimeSupplement(event.text));
  const nextTitle = getRecentActivityTitleUpdate(event, decision, recent);
  if (!wantsTimeChange && !nextTitle) {
    return undefined;
  }

  let intent: CalendarIntent | undefined;
  const patchData: Record<string, unknown> = {};
  if (wantsTimeChange) {
    try {
      intent = parseCalendarIntent(buildRecentActivityCalendarText(recent, decision, event.text));
    } catch (error) {
      if (error instanceof Error && error.message === "missing_explicit_time") {
        return "我知道你想改这个安排，但还缺一个明确时间。可以直接说：改到明天晚上10:30。";
      }
      throw error;
    }

    if (!intent) {
      return undefined;
    }

    patchData.start_time = {
      timestamp: toUnixSeconds(intent.start),
      timezone: "Asia/Shanghai",
    };
    patchData.end_time = {
      timestamp: toUnixSeconds(intent.end),
      timezone: "Asia/Shanghai",
    };
  }

  if (nextTitle) {
    patchData.summary = nextTitle;
  }

  let failure: string | undefined;
  try {
    failure = await patchRecentCalendarEventFields(recent, patchData);
  } catch (error) {
    console.error("更新日程失败:", error);
    return `我理解你想改这个日程，但飞书日历更新失败：${sanitizeError(error)}`;
  }
  if (failure) {
    return failure;
  }

  if (intent) {
    recent.start = intent.start;
    recent.end = intent.end;
    recent.approximate = false;
    recent.timeHint = decision.timeHint || inferTimeHint(event.text) || formatCalendarTimeRange(intent);
  }
  if (nextTitle) {
    recent.title = nextTitle;
  }
  recent.sourceText = `${recent.sourceText}\n${event.text}`;
  recent.updatedAt = Date.now();
  createOrUpdateTopicFromActivity(event, recent, "updating");
  setRecentActivity(recent);

  const reply = [
    `改好了：${recent.title}`,
    intent ? `时间：${formatCalendarTimeRange(intent)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (recent.cardMessageId) {
    try {
      await updateInteractiveMessage(
        recent.cardMessageId,
        buildCreatedActivityCard(pendingActivityFromRecent(recent), reply),
      );
    } catch (error) {
      console.warn("更新已创建卡片失败，保留文本回复:", sanitizeError(error));
    }
  }

  return reply;
}

async function confirmPendingCreate(pending: PendingActivity) {
  const attendeeIds = pending.participantCandidates.map((participant) => participant.openId);
  const source = `创建日程「${pending.title}」 ${pending.timeHint || ""} ${pending.sourceText}`;
  const result = await createCalendarEventFromText(source, attendeeIds, { allowApproximate: true });

  if (result && isCalendarCreateSuccess(result)) {
    pendingActivities.delete(pending.chatId);
    rememberRecentActivityFromPending(pending, result);
  }

  return result?.reply || "我还需要一个明确开始时间，例如：明天晚上7点。";
}

function hasGroundingEvidence(decision: IntentDecision) {
  return Boolean(decision.grounding.messageIds.length || decision.grounding.evidenceTexts.length);
}

function guardUnsafeToolAction(
  event: NormalizedMessageEvent,
  pending: PendingActivity | undefined,
  recent: RecentActivity | undefined,
  decision: IntentDecision,
): BotAction | undefined {
  if (decision.toolIntent === "none") {
    return undefined;
  }

  if (decision.safetyLabel !== "normal") {
    const reason = `安全闸拦截: safety=${decision.safetyLabel} tool=${decision.toolIntent}`;
    console.log(reason);
    if (isDirectMention(event) || isPrivateChat(event)) {
      return {
        type: "text",
        content:
          decision.assistantReply ||
          "我先不动飞书工具了。这句话更像是在吐槽/假设/玩笑，真要我安排的话，可以直接说清楚标题、时间和参与人。",
      };
    }
    return { type: "silent", reason };
  }

  if (!hasGroundingEvidence(decision)) {
    return {
      type: isDirectMention(event) || isPrivateChat(event) ? "text" : "silent",
      content: "我还缺少能定位这个动作的原文证据，先不写入飞书。你可以直接说清楚要创建或修改哪个安排。",
      reason: "工具动作缺少 grounding evidence",
    } as BotAction;
  }

  if (decision.toolIntent === "calendar_update" && !pending && !recent) {
    if (isDirectMention(event) || isPrivateChat(event)) {
      return {
        type: "text",
        content: "我不确定你要修改哪个安排，先不动日历。你可以回复具体日程卡片，或说“把项目同步会改到明天下午5点”。",
      };
    }
    return { type: "silent", reason: "没有可安全承接的日程 topic" };
  }

  return undefined;
}

async function executeIntent(
  event: NormalizedMessageEvent,
  context: ChatContext,
  decision: IntentDecision,
): Promise<BotAction> {
  const text = event.text;
  const pending = getPendingActivity(event.chatId);
  const recent = getRecentActivity(event.chatId);
  const pendingRelevant = isPendingActivityFollowup(event, pending, text);
  const recentRelevant = isRecentActivityFollowup(event, recent, text);

  if (
    decision.safetyLabel === "ambiguous" &&
    decision.toolIntent === "calendar_create" &&
    !isDirectMention(event) &&
    !isPrivateChat(event)
  ) {
    rememberTentativeActivity(event, context, decision);
    return { type: "silent", reason: "含条件表达的候选活动，先观察共识" };
  }

  const blockedAction = guardUnsafeToolAction(
    event,
    pendingRelevant ? pending : undefined,
    recentRelevant ? recent : undefined,
    decision,
  );
  if (blockedAction) {
    return blockedAction;
  }

  if (pending && pendingRelevant && isParticipantAdjustment(text)) {
    return { type: "text", content: await applyParticipantAdjustment(event, context, pending) };
  }

  if (pending && pendingRelevant && isCreateConfirmation(text)) {
    return { type: "text", content: await confirmPendingCreate(pending) };
  }

  if (pending && pendingRelevant && isTimeSupplement(text)) {
    pending.timeHint = inferTimeHint(text) || pending.timeHint;
    pending.sourceText = `${pending.sourceText} ${text}`;
    pending.missingFields = pending.missingFields.filter((field) => !field.includes("时间"));
    pending.topicId = createOrUpdateTopicFromActivity(event, pending, "confirming").id;
    pendingActivities.set(pending.chatId, pending);
    return { type: "text", content: await confirmPendingCreate(pending) };
  }

  if (pending && pendingRelevant && isKeepCandidate(text)) {
    pending.status = "pending";
    pendingActivities.set(pending.chatId, pending);
    return { type: "text", content: `好的，先保留候选安排：${pending.title}。` };
  }

  if (pending && pendingRelevant && isCancelExpression(text)) {
    if (/(确认取消|取消候选|先不创建|不用创建|不创建了)/.test(text)) {
      pendingActivities.delete(pending.chatId);
      return { type: "text", content: `已取消候选安排：${pending.title}。` };
    }

    pending.status = "cancel_confirmation";
    pendingActivities.set(pending.chatId, pending);
    return {
      type: "card",
      card: buildCancelCard(pending),
      fallbackText: buildCancelFallbackText(pending),
    };
  }

  if (pending && pendingRelevant && decision.intent === "cancel_or_change_candidate" && decision.confidence >= 0.55) {
    const updateReply = await applyModelPendingUpdate(pending, decision);
    if (updateReply) {
      return { type: "text", content: updateReply };
    }
  }

  if (!pending && recent && recentRelevant && decision.intent === "cancel_or_change_candidate" && decision.confidence >= 0.55) {
    const updateReply = await applyRecentActivityUpdate(event, decision, recent);
    if (updateReply) {
      return { type: "text", content: updateReply };
    }
  }

  if (pending && pendingRelevant && decision.toolIntent === "calendar_update" && decision.confidence >= 0.55) {
    const updateReply = await applyModelPendingUpdate(pending, {
      ...decision,
      intent: "cancel_or_change_candidate",
    });
    if (updateReply) {
      return { type: "text", content: updateReply };
    }
  }

  if (!pending && recent && recentRelevant && decision.toolIntent === "calendar_update" && decision.confidence >= 0.55) {
    const updateReply = await applyRecentActivityUpdate(
      event,
      {
        ...decision,
        intent: "cancel_or_change_candidate",
      },
      recent,
    );
    if (updateReply) {
      return { type: "text", content: updateReply };
    }
  }

  if (decision.responseMode === "silent" && !isDirectMention(event) && !isPrivateChat(event)) {
    return { type: "silent", reason: "模型判断继续观察" };
  }

  if (decision.responseMode === "chat" || decision.responseMode === "suggest") {
    if (decision.assistantReply) {
      return { type: "text", content: decision.assistantReply };
    }

    if (isDirectMention(event) || isPrivateChat(event)) {
      try {
        const llmReply = await callLlm(event, context);
        if (llmReply) {
          return { type: "text", content: llmReply };
        }
      } catch (error) {
        console.error("大模型回复失败:", error);
      }
    }
  }

  if (
    decision.toolIntent === "calendar_create" &&
    decision.confidence >= 0.5 &&
    (decision.responseMode === "confirm_action" ||
      decision.requiresConfirmation ||
      decision.shouldAskConfirmation ||
      decision.intent === "social_schedule_candidate")
  ) {
    const pendingActivity = createPendingActivity(event, {
      ...decision,
      intent: "social_schedule_candidate",
      shouldAskConfirmation: true,
    });
    return {
      type: "card",
      card: buildActivityCard(pendingActivity),
      fallbackText: buildActivityFallbackText(pendingActivity),
    };
  }

  if (
    decision.toolIntent === "calendar_create" &&
    decision.responseMode === "execute_action" &&
    decision.confidence >= 0.5
  ) {
    const calendarResult = await createCalendarEventFromText(text);
    if (calendarResult) {
      rememberRecentActivityFromEvent(event, decision, calendarResult);
      return { type: "text", content: calendarResult.reply };
    }
  }

  if (
    decision.toolIntent !== "none" &&
    decision.toolIntent !== "calendar_create" &&
    decision.toolIntent !== "calendar_update" &&
    decision.requiresConfirmation
  ) {
    return {
      type: "text",
      content:
        decision.assistantReply ||
        "可以，我先按这个方向理解。这个动作会写入飞书协作内容，我建议先确认范围和负责人，再帮你落成任务、文档或项目计划。",
    };
  }

  if (decision.intent === "ignore" || decision.confidence < 0.5) {
    if (isDirectMention(event) || isPrivateChat(event)) {
      if (isGreetingIntent(text)) {
        return {
          type: "text",
          content:
            "我在。你可以直接和我聊项目推进、任务拆解、会议安排或风险判断；需要我动飞书工具时，我会先说明要做什么。",
        };
      }

      if (isPingIntent(text)) {
        return { type: "text", content: "我在，监听进程正常收到你的消息。" };
      }

      try {
        const llmReply = await callLlm(event, context);
        if (llmReply) {
          return { type: "text", content: llmReply };
        }
      } catch (error) {
        console.error("大模型回复失败:", error);
      }

      return {
        type: "text",
        content: "我听懂你在找我，但还缺一点上下文。你可以直接说想讨论的问题，或者告诉我要不要把它整理成日程、任务、文档或项目计划。",
      };
    }

    return { type: "silent", reason: "未命中发言门禁" };
  }

  if (decision.intent === "social_schedule_candidate") {
    if (!decision.shouldAskConfirmation && event.chatId) {
      if (isDirectMention(event) || isPrivateChat(event)) {
        if (isOpinionSeekingExpression(text) && !isStrongScheduleDecision(text) && !isCalendarCreateIntent(text)) {
          rememberTentativeActivity(event, context, decision);
          return {
            type: "text",
            content:
              "我先把它记成一个候选安排，等大家明确同意，或者有人补充时间/地点/参与人后，我再发创建日程的确认卡片。",
          };
        }

        const pendingActivity = createPendingActivity(event, {
          ...decision,
          shouldAskConfirmation: true,
        });
        return {
          type: "card",
          card: buildActivityCard(pendingActivity),
          fallbackText: buildActivityFallbackText(pendingActivity),
        };
      }

      rememberTentativeActivity(event, context, decision);
      return { type: "silent", reason: "模型判断为早期候选活动，继续观察共识" };
    }

    const pendingActivity = createPendingActivity(event, decision);
    return {
      type: "card",
      card: buildActivityCard(pendingActivity),
      fallbackText: buildActivityFallbackText(pendingActivity),
    };
  }

  if (decision.intent === "explicit_schedule_create") {
    if (hasActivityKeyword(text) && hasGroupPlanningCue(text)) {
      const pendingActivity = createPendingActivity(event, {
        ...decision,
        intent: "social_schedule_candidate",
        shouldAskConfirmation: true,
      });
      return {
        type: "card",
        card: buildActivityCard(pendingActivity),
        fallbackText: buildActivityFallbackText(pendingActivity),
      };
    }

    const calendarResult = await createCalendarEventFromText(text);
    if (calendarResult) {
      rememberRecentActivityFromEvent(event, decision, calendarResult);
      return { type: "text", content: calendarResult.reply };
    }
  }

  if (decision.intent === "project_request" || text.includes("创建项目")) {
    if (decision.assistantReply) {
      return { type: "text", content: decision.assistantReply };
    }

    if (isDirectMention(event) || isPrivateChat(event)) {
      try {
        const llmReply = await callLlm(event, context);
        if (llmReply) {
          return { type: "text", content: llmReply };
        }
      } catch (error) {
        console.error("大模型回复失败:", error);
      }
    }

    return {
      type: "text",
      content: "我可以一起梳理。先给我一个目标和当前卡点，我会帮你拆成下一步、负责人和需要沉淀的飞书动作。",
    };
  }

  if (isDirectMention(event) || isPrivateChat(event)) {
    if (isGreetingIntent(text)) {
      return {
        type: "text",
        content:
          "我在。你可以直接和我聊项目推进、任务拆解、会议安排或风险判断；需要我动飞书工具时，我会先说明要做什么。",
      };
    }

    if (isPingIntent(text)) {
      return { type: "text", content: "我在，监听进程正常收到你的消息。" };
    }

    try {
      const llmReply = await callLlm(event, context);
      if (llmReply) {
        return { type: "text", content: llmReply };
      }
    } catch (error) {
      console.error("大模型回复失败:", error);
    }
  }

  return { type: "silent", reason: "没有可执行意图" };
}

async function routeTentativeActivity(
  event: NormalizedMessageEvent,
  context: ChatContext,
): Promise<BotAction | undefined> {
  if (!event.chatId) {
    return undefined;
  }

  const text = event.text.trim();
  const recent = getRecentActivity(event.chatId);
  if (isRecentActivityFollowup(event, recent, text)) {
    return undefined;
  }

  if (!isDirectMention(event) && !isPrivateChat(event) && isTentativeSocialCandidate(event, text)) {
    rememberTentativeActivity(event, context);
    return { type: "silent", reason: "候选活动仍在征询意见，继续观察" };
  }

  const tentative = getTentativeActivity(event.chatId);
  if (!tentative) {
    return undefined;
  }
  if (!isTentativeActivityFollowup(event, tentative, text)) {
    return undefined;
  }

  if (isNegativeActivityMessage(text) || isCancelExpression(text)) {
    tentativeActivities.delete(event.chatId);
    return { type: "silent", reason: "候选活动被否定，取消观察" };
  }

  if (hasActivityDetail(text) || isAgreementExpression(text)) {
    updateTentativeFromMessage(tentative, event);
  }

  if (!shouldPromoteTentativeActivity(event, tentative, text)) {
    return hasActivityDetail(text)
      ? { type: "silent", reason: "已补充候选活动信息，等待明确共识" }
      : undefined;
  }

  const { members, incomplete } = await getChatMembers(event.chatId, context, event);
  const supporterCandidates: ParticipantCandidate[] = [];
  for (const supporterId of tentative.supporterIds) {
    const member = members.find((item) => item.openId === supporterId);
    if (member) {
      supporterCandidates.push({
        openId: member.openId,
        name: member.name,
        reason: "明确表示同意",
      });
    }
  }
  const participantCandidates = uniqueByOpenId([
    ...fallbackParticipantCandidates(event, context, members),
    ...supporterCandidates,
  ]);
  const sourceText = [tentative.sourceText, ...tentative.detailTexts, text].join("\n");
  const decision: IntentDecision = {
    intent: "social_schedule_candidate",
    confidence: 0.82,
    responseMode: "confirm_action",
    toolIntent: "calendar_create",
    topicAction: "create_topic",
    topicId: tentative.topicId,
    grounding: defaultGrounding(event),
    safetyLabel: detectSafetyLabel(event),
    activityTitle: tentative.title,
    timeHint: tentative.timeHint || inferTimeHint(sourceText),
    participantCandidates,
    missingFields: tentative.timeHint || hasExplicitCalendarTime(sourceText) ? [] : ["具体时间"],
    shouldAskConfirmation: true,
    requiresConfirmation: true,
    memberLookupIncomplete: incomplete,
  };
  tentativeActivities.delete(event.chatId);
  const pendingActivity = createPendingActivity({ ...event, text: sourceText }, decision);
  pendingActivity.locationHint = tentative.locationHint || extractLocationHint(sourceText);
  pendingActivity.sourceText = sourceText;
  pendingActivities.set(event.chatId, pendingActivity);

  return {
    type: "card",
    card: buildActivityCard(pendingActivity),
    fallbackText: buildActivityFallbackText(pendingActivity),
  };
}

async function routeMessage(event: NormalizedMessageEvent) {
  if (!event.text.trim()) {
    return { type: "silent", reason: "非文本或空文本" } satisfies BotAction;
  }

  const context = getRecentContext(event);
  const tentativeAction = await routeTentativeActivity(event, context);
  if (tentativeAction) {
    return tentativeAction;
  }

  const decision = await classifyIntent(event, context);
  console.log(
    `路由结果: mode=${decision.responseMode} tool=${decision.toolIntent} intent=${decision.intent} confidence=${decision.confidence.toFixed(2)} participants=${decision.participantCandidates.length}`,
  );
  return executeIntent(event, context, decision);
}

async function handleMessage(raw: IncomingMessageEvent) {
  const event = normalizeEvent(raw);
  if (!event) {
    return;
  }

  await handleNormalizedMessage(event);
}

async function handleIncomingEvent(raw: IncomingMessageEvent) {
  const type = raw.type || raw.header?.event_type;
  if (type === CARD_ACTION_EVENT_TYPE) {
    await handleCardAction(raw);
    return;
  }

  await handleMessage(raw);
}

async function handleNormalizedMessage(event: NormalizedMessageEvent) {
  if (event.senderType === "app") {
    return;
  }

  if (event.messageId) {
    if (handledMessageIds.has(event.messageId)) {
      return;
    }
    handledMessageIds.add(event.messageId);
  }

  console.log(
    `收到消息: ${event.text || `[${event.messageType || "unknown"}]`} (from: ${event.senderId || "unknown"})`,
  );

  const context = rememberMessage(event) || getRecentContext(event);
  await sendProcessingReceipt(event, context);
  try {
    const action = await routeMessage(event);
    await sendAction(event, action);
    if (action.type !== "silent") {
      console.log(`已处理 message_id=${event.messageId || "(none)"} action=${action.type}`);
    }
  } finally {
    await clearProcessingReceipt(event);
  }
}

function getPollChatIds() {
  return (process.env.LARK_POLL_CHAT_IDS || "")
    .split(",")
    .map((chatId) => chatId.trim())
    .filter(Boolean);
}

async function listRecentMessages(chatId: string) {
  const result = await runLarkCli(
    [
      "im",
      "+chat-messages-list",
      "--chat-id",
      chatId,
      "--page-size",
      "10",
      "--format",
      "json",
    ],
    "bot",
  );

  const messages = (result as { data?: { messages?: Array<Record<string, unknown>> } }).data
    ?.messages;
  return Array.isArray(messages) ? messages : [];
}

function normalizePolledMessage(
  chatId: string,
  message: Record<string, unknown>,
): NormalizedMessageEvent | undefined {
  const messageId = typeof message.message_id === "string" ? message.message_id : undefined;
  const sender = message.sender as { id?: string; sender_type?: string; name?: string } | undefined;
  const senderType = sender?.sender_type;

  if (!messageId || senderType === "app") {
    return undefined;
  }

  return {
    type: MESSAGE_EVENT_TYPE,
    messageId,
    chatId,
    senderId: sender?.id,
    senderName: sender?.name,
    senderType,
    messageType: typeof message.msg_type === "string" ? message.msg_type : undefined,
    mentions: normalizeMentions(message.mentions),
    createTime: parseEventTime(
      typeof message.create_time === "string" || typeof message.create_time === "number"
        ? message.create_time
        : undefined,
    ),
    text: normalizeContent(message.content),
  };
}

async function seedPolledMessages(chatIds: string[]) {
  for (const chatId of chatIds) {
    try {
      const messages = await listRecentMessages(chatId);
      for (const message of messages) {
        const messageId =
          typeof message.message_id === "string" ? message.message_id : undefined;
        if (messageId) {
          handledMessageIds.add(messageId);
        }
      }
      console.log(`轮询会话已初始化: ${chatId}，忽略历史消息 ${messages.length} 条`);
    } catch (error) {
      console.error(`初始化轮询会话失败: ${chatId}`, error);
    }
  }
}

async function pollChatsOnce(chatIds: string[]) {
  for (const chatId of chatIds) {
    try {
      const messages = await listRecentMessages(chatId);
      for (const message of messages.reverse()) {
        const event = normalizePolledMessage(chatId, message);
        if (event) {
          await handleNormalizedMessage(event);
        }
      }
    } catch (error) {
      console.error(`轮询会话失败: ${chatId}`, error);
    }
  }
}

async function startPollingFallback() {
  const chatIds = getPollChatIds();
  if (!chatIds.length) {
    console.log("未配置 LARK_POLL_CHAT_IDS，跳过消息轮询兜底。");
    return;
  }

  await seedPolledMessages(chatIds);
  console.log(`消息轮询兜底已启动: ${chatIds.join(", ")}，间隔 ${POLL_INTERVAL_MS}ms`);

  setInterval(() => {
    pollChatsOnce(chatIds).catch((error) => {
      console.error("轮询任务失败:", error);
    });
  }, POLL_INTERVAL_MS);
}

function scheduleRestart(code: number | null, signal: NodeJS.Signals | null) {
  if (stopping) {
    return;
  }

  const delay = Math.min(
    RESTART_BASE_DELAY_MS * Math.max(1, restartCount + 1),
    RESTART_MAX_DELAY_MS,
  );
  restartCount += 1;

  console.warn(
    `事件监听已退出 code=${code ?? "null"} signal=${signal ?? "null"}，${delay / 1000}s 后重启...`,
  );
  setTimeout(() => {
    startListener().catch((error) => {
      console.error("重启监听失败:", error);
      scheduleRestart(null, null);
    });
  }, delay);
}

async function startListener() {
  await ensureLarkCliReady();
  await startPollingFallback();

  console.log("ProjectPilot 机器人启动，正在监听飞书消息...");

  const child = spawn(
    LARK_BIN,
    [
      "event",
      "+subscribe",
      "--event-types",
      EVENT_TYPES,
      "--compact",
      "--quiet",
      "--as",
      "bot",
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  listener = child;

  child.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) {
        continue;
      }

      try {
        handleIncomingEvent(JSON.parse(trimmed)).catch((error) => {
          console.error("处理消息失败:", error);
        });
      } catch (error) {
        console.error("解析事件失败:", error, trimmed);
      }
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const message = data.toString().trim();
    if (message) {
      console.warn("监听日志:", message);
    }
  });

  child.on("error", (error) => {
    console.error("事件监听进程启动失败:", error);
  });

  child.on("exit", (code, signal) => {
    listener = undefined;
    scheduleRestart(code, signal);
  });
}

function shutdown() {
  stopping = true;
  listener?.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

loadLocalEnv();
loadRecentActivities();

startListener().catch((error) => {
  console.error("启动失败:", error);
  process.exitCode = 1;
});
