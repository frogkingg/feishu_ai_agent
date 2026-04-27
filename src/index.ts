import { ChildProcess, execFile, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
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
const MEMBER_CACHE_TTL_MS = Number(process.env.PROJECTPILOT_MEMBER_CACHE_TTL_MS || 10 * 60_000);
const BOT_NAMES = (process.env.PROJECTPILOT_BOT_NAMES || "测试项目知识中枢 Agent,ProjectPilot,项目领航员,机器人")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

let listener: ChildProcess | undefined;
let restartCount = 0;
let stopping = false;
const handledMessageIds = new Set<string>();
const chatContexts = new Map<string, ChatContext>();
const pendingActivities = new Map<string, PendingActivity>();
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

async function callLlm(event: NormalizedMessageEvent) {
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
            content:
              "你是 ProjectPilot，一个常驻在飞书里的项目管理专家 Agent。用简洁中文回复，优先帮助用户推进项目立项、任务拆解、会议待办、风险识别和飞书协作。不要声称已经执行了外部操作，除非上下文明确显示已经完成。",
          },
          {
            role: "user",
            content: event.text,
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
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        messages,
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

interface CalendarIntent {
  summary: string;
  start: string;
  end: string;
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

interface IntentDecision {
  intent: IntentKind;
  confidence: number;
  activityTitle?: string;
  timeHint?: string;
  participantCandidates: ParticipantCandidate[];
  missingFields: string[];
  shouldAskConfirmation: boolean;
  memberLookupIncomplete?: boolean;
}

interface PendingActivity {
  id: string;
  chatId: string;
  sourceText: string;
  sourceMessageId?: string;
  createdAt: number;
  title: string;
  timeHint?: string;
  participantCandidates: ParticipantCandidate[];
  missingFields: string[];
  memberLookupIncomplete?: boolean;
  status: "pending" | "cancel_confirmation";
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

function isParticipantAdjustment(text: string) {
  return /(加上|带上|拉上|别拉|去掉|调整参与人|参与人)/.test(text);
}

function isNegativeActivityMessage(text: string) {
  return /(不想|不去|不吃|不约|算了|取消|别|还是不)/.test(text);
}

function hasActivityKeyword(text: string) {
  return /(烧烤|聚餐|约饭|吃饭|火锅|团建|出去玩|唱歌|咖啡|看电影|喝酒|夜宵|午饭|晚饭|活动|小聚)/.test(
    text,
  );
}

function hasGroupPlanningCue(text: string) {
  return /(一起|我们|大家|全员|所有人|要不要|去不去|想去|约|安排|明天|今晚|晚上|周末|下周|改天|几点|什么时候|拉上|带上)/.test(
    text,
  );
}

function isSocialScheduleCandidate(text: string) {
  if (!hasActivityKeyword(text) || isNegativeActivityMessage(text)) {
    return false;
  }

  return hasGroupPlanningCue(text);
}

function shouldRespond(event: NormalizedMessageEvent, context: ChatContext): boolean {
  const text = event.text.trim();
  if (!text) {
    return false;
  }

  const pending = getPendingActivity(event.chatId);
  if (
    pending &&
    (isCancelExpression(text) ||
      isCreateConfirmation(text) ||
      isParticipantAdjustment(text) ||
      isKeepCandidate(text))
  ) {
    return true;
  }

  if (isPrivateChat(event) || isDirectMention(event)) {
    return true;
  }

  if (isCalendarCreateIntent(text) || isProjectIntent(text)) {
    return true;
  }

  if (isSocialScheduleCandidate(text)) {
    return true;
  }

  if (context.messages.length >= 2 && pending && isCancelExpression(text)) {
    return true;
  }

  return false;
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

function uniqueByOpenId(candidates: ParticipantCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
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

  if (/(所有人|全员|大家|我们所有人)/.test(event.text) && members.length) {
    candidates.push(
      ...members.slice(0, 30).map((member) => ({
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
  const contextPayload = context.messages.slice(-CONTEXT_MAX_MESSAGES).map((message) => ({
    sender_id: message.senderId,
    sender_name: message.senderName,
    text: message.text,
    mentions: message.mentions,
    create_time: new Date(message.createTime).toISOString(),
  }));
  const memberPayload = members.map((member) => ({
    open_id: member.openId,
    name: member.name,
  }));

  const raw = await callStructuredLlm([
    {
      role: "system",
      content: [
        "你是 ProjectPilot 的群聊意图分类器，只输出 JSON 对象，不要输出解释。",
        "你的任务是判断机器人是否需要介入，并为多人活动推荐可能参与人。",
        "只能从候选群成员列表里选择 participant_candidates，不能凭空编人。",
        "普通闲聊、情绪附和、无明确行动价值的消息必须输出 intent=ignore。",
        "多人活动如聚餐、烧烤、团建、出去玩、改天约，若像是在组织安排，输出 social_schedule_candidate，并 should_ask_confirmation=true。",
        "如果用户是在取消/变更一个刚才讨论的候选活动，输出 cancel_or_change_candidate。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        current_date: new Date().toISOString(),
        current_message: {
          sender_id: event.senderId,
          sender_name: event.senderName,
          text: event.text,
          mentions: event.mentions || [],
        },
        recent_context: contextPayload,
        chat_members: memberPayload,
        member_lookup_incomplete: memberLookupIncomplete,
        output_schema: {
          intent:
            "explicit_schedule_create | social_schedule_candidate | cancel_or_change_candidate | project_request | ignore",
          confidence: "0..1",
          activity_title: "string or empty",
          time_hint: "string or empty",
          participant_candidates: [
            { open_id: "must be one of chat_members.open_id", name: "member name", reason: "short" },
          ],
          missing_fields: ["string"],
          should_ask_confirmation: "boolean",
        },
      }),
    },
  ]);

  if (!raw) {
    return undefined;
  }

  const intent = normalizeIntent(raw.intent);
  const confidence = typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence || 0);
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

  return {
    intent,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    activityTitle,
    timeHint,
    participantCandidates,
    missingFields,
    shouldAskConfirmation,
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

  if (getPendingActivity(event.chatId) && (isCancelExpression(text) || isParticipantAdjustment(text))) {
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
    activityTitle: inferActivityTitle(text),
    timeHint,
    participantCandidates,
    missingFields: timeHint && hasExplicitCalendarTime(text) ? [] : ["具体时间"],
    shouldAskConfirmation: intent === "social_schedule_candidate",
    memberLookupIncomplete,
  };
}

async function classifyIntent(
  event: NormalizedMessageEvent,
  context: ChatContext,
): Promise<IntentDecision> {
  if (!shouldRespond(event, context)) {
    return {
      intent: "ignore",
      confidence: 0,
      participantCandidates: [],
      missingFields: [],
      shouldAskConfirmation: false,
    };
  }

  const { members, incomplete } =
    event.chatId && !isPrivateChat(event)
      ? await getChatMembers(event.chatId, context, event)
      : { members: fallbackMembersFromContext(context, event), incomplete: false };

  const fallback = classifyHeuristically(event, context, members, incomplete);
  if (fallback.intent === "social_schedule_candidate" || fallback.intent === "cancel_or_change_candidate") {
    try {
      const modelDecision = await classifyWithModel(event, context, members, incomplete);
      if (modelDecision && modelDecision.confidence >= 0.55 && modelDecision.intent !== "ignore") {
        if (!modelDecision.participantCandidates.length) {
          modelDecision.participantCandidates = fallback.participantCandidates;
        }
        if (!modelDecision.activityTitle) {
          modelDecision.activityTitle = fallback.activityTitle;
        }
        if (!modelDecision.timeHint) {
          modelDecision.timeHint = fallback.timeHint;
        }
        if (!modelDecision.missingFields.length) {
          modelDecision.missingFields = fallback.missingFields;
        }
        return modelDecision;
      }
    } catch (error) {
      console.error("结构化意图判断失败，使用启发式结果:", error);
    }
  }

  return fallback;
}

function isCalendarCreateIntent(text: string) {
  return /(创建|新建|安排|预约|约|添加).{0,12}(日程|日历|会议|会)/i.test(text);
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
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
  if (!isCalendarCreateIntent(text)) {
    return undefined;
  }

  const rangeMatch = text.match(
    /(上午|早上|中午|下午|晚上|今晚)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)?\s*(?:分)?\s*(?:到|至|-|~|—)\s*(上午|早上|中午|下午|晚上)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)?\s*(?:分)?/,
  );
  const singleMatch = text.match(/(上午|早上|中午|下午|晚上|今晚)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)\s*(?:分)?/);

  if (!rangeMatch && !singleMatch) {
    throw new Error("missing_explicit_time");
  }

  const baseDate = resolveBaseDate(text, now);
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
    end = new Date(start.getTime() + parseDurationMinutes(text) * 60_000);
  }

  if (!/(今天|今日|明天|明日|后天|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日?)/.test(text) && start <= now) {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 1);
  }

  return {
    summary: extractSummary(text),
    start: toLocalIso(start),
    end: toLocalIso(end),
  };
}

function formatCalendarResult(intent: CalendarIntent) {
  return `已创建日程：${intent.summary}\n时间：${intent.start} - ${intent.end}`;
}

function sanitizeError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(app_secret|access_token|refresh_token|Authorization)["':=\s]+[^"',\s}]+/gi, "$1=***")
    .slice(0, 700);
}

async function createCalendarEventFromText(text: string, attendeeIds: string[] = []) {
  let intent: CalendarIntent | undefined;
  try {
    intent = parseCalendarIntent(text);
  } catch (error) {
    if (error instanceof Error && error.message === "missing_explicit_time") {
      return "我可以创建日程了。基础版本请给我一个明确开始时间，例如：明天下午3点创建日程「项目同步会」。";
    }
    throw error;
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

    await runLarkCli(args, "user");
    return formatCalendarResult(intent);
  } catch (error) {
    console.error("创建日程失败:", error);
    return `我收到了创建日程请求，但飞书日历创建失败：${sanitizeError(error)}`;
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

function normalizeCardAction(raw: IncomingMessageEvent): CardActionEvent | undefined {
  const type = raw.type || raw.header?.event_type;
  if (type !== CARD_ACTION_EVENT_TYPE) {
    return undefined;
  }

  const actionValue = raw.event?.action?.value;
  const value =
    typeof actionValue === "string"
      ? (JSON.parse(actionValue) as Record<string, unknown>)
      : actionValue && typeof actionValue === "object"
        ? (actionValue as Record<string, unknown>)
        : {};

  return {
    type,
    action: getString(value.action),
    candidateId: getString(value.candidate_id) || getString(value.candidateId),
    chatId:
      raw.event?.context?.open_chat_id ||
      getString((raw as Record<string, unknown>).open_chat_id) ||
      raw.chat_id,
    messageId:
      raw.event?.context?.open_message_id ||
      getString((raw as Record<string, unknown>).open_message_id) ||
      raw.message_id,
    operatorId:
      raw.event?.operator?.open_id ||
      getString((raw as Record<string, unknown>).open_id) ||
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
    await sendMessage(eventFromCardAction(cardEvent, "确认创建"), await confirmPendingCreate(pending));
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
    config: { wide_screen_mode: true },
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
    chatId: event.chatId,
    sourceText: event.text,
    sourceMessageId: event.messageId,
    createdAt: Date.now(),
    title: decision.activityTitle || inferActivityTitle(event.text),
    timeHint: decision.timeHint || inferTimeHint(event.text),
    participantCandidates: decision.participantCandidates,
    missingFields: decision.missingFields.length
      ? decision.missingFields
      : hasExplicitCalendarTime(event.text)
        ? []
        : ["具体时间"],
    memberLookupIncomplete: decision.memberLookupIncomplete,
    status: "pending",
  };
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

  const { members } = await getChatMembers(event.chatId, context, event);
  const matched = members.filter((member) => event.text.includes(member.name));
  if (!matched.length) {
    return "我还没识别出要调整的成员。可以直接说：加上张三，或去掉李四。";
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

  pendingActivities.set(pending.chatId, pending);
  return `已更新建议参与人：${formatParticipantNames(pending.participantCandidates)}。回复「确认创建」后我再创建日程。`;
}

async function confirmPendingCreate(pending: PendingActivity) {
  const attendeeIds = pending.participantCandidates.map((participant) => participant.openId);
  const source = `创建日程「${pending.title}」 ${pending.timeHint || ""} ${pending.sourceText}`;
  const result = await createCalendarEventFromText(source, attendeeIds);

  if (!result?.includes("请给我一个明确开始时间")) {
    pendingActivities.delete(pending.chatId);
  }

  return result || "我还需要一个明确开始时间，例如：明天晚上7点。";
}

async function executeIntent(
  event: NormalizedMessageEvent,
  context: ChatContext,
  decision: IntentDecision,
): Promise<BotAction> {
  const text = event.text;
  const pending = getPendingActivity(event.chatId);

  if (pending && isParticipantAdjustment(text)) {
    return { type: "text", content: await applyParticipantAdjustment(event, context, pending) };
  }

  if (pending && isCreateConfirmation(text)) {
    return { type: "text", content: await confirmPendingCreate(pending) };
  }

  if (pending && isKeepCandidate(text)) {
    pending.status = "pending";
    pendingActivities.set(pending.chatId, pending);
    return { type: "text", content: `好的，先保留候选安排：${pending.title}。` };
  }

  if (pending && isCancelExpression(text)) {
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

  if (decision.intent === "ignore" || decision.confidence < 0.5) {
    return { type: "silent", reason: "未命中发言门禁" };
  }

  if (decision.intent === "social_schedule_candidate") {
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

    const calendarReply = await createCalendarEventFromText(text);
    if (calendarReply) {
      return { type: "text", content: calendarReply };
    }
  }

  if (decision.intent === "project_request" || text.includes("创建项目")) {
    return {
      type: "text",
      content: "好的，我正在解析你的项目需求。请补充项目名称、目标、截止时间、成员和分工信息。",
    };
  }

  if (isDirectMention(event) || isPrivateChat(event)) {
    if (isGreetingIntent(text)) {
      return {
        type: "text",
        content:
          "你好，我在。现在我会安静监听群聊，只在 @我、明确要创建日程/项目，或出现高置信度多人安排时介入。",
      };
    }

    if (isPingIntent(text)) {
      return { type: "text", content: "我在，监听进程正常收到你的消息。" };
    }

    try {
      const llmReply = await callLlm(event);
      if (llmReply) {
        return { type: "text", content: llmReply };
      }
    } catch (error) {
      console.error("大模型回复失败:", error);
    }
  }

  return { type: "silent", reason: "没有可执行意图" };
}

async function routeMessage(event: NormalizedMessageEvent) {
  if (!event.text.trim()) {
    return { type: "silent", reason: "非文本或空文本" } satisfies BotAction;
  }

  const context = getRecentContext(event);
  const decision = await classifyIntent(event, context);
  console.log(
    `路由结果: intent=${decision.intent} confidence=${decision.confidence.toFixed(2)} participants=${decision.participantCandidates.length}`,
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

  rememberMessage(event);
  const action = await routeMessage(event);
  await sendAction(event, action);
  if (action.type !== "silent") {
    console.log(`已处理 message_id=${event.messageId || "(none)"} action=${action.type}`);
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

startListener().catch((error) => {
  console.error("启动失败:", error);
  process.exitCode = 1;
});
