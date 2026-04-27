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
  sender_id?: string;
  message_type?: string;
  event?: {
    message?: {
      chat_id?: string;
      content?: string;
      message_id?: string;
      message_type?: string;
    };
    sender?: {
      sender_id?: {
        open_id?: string;
      };
    };
  };
  header?: {
    event_type?: string;
  };
}

const EVENT_TYPE = "im.message.receive_v1";
const RESTART_BASE_DELAY_MS = 2_000;
const RESTART_MAX_DELAY_MS = 30_000;
const LARK_BIN = process.env.LARK_CLI_BIN || "lark-cli";
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 20_000);
const LLM_MAX_REPLY_CHARS = Number(process.env.LLM_MAX_REPLY_CHARS || 1_800);
const POLL_INTERVAL_MS = Number(process.env.LARK_POLL_INTERVAL_MS || 5_000);
const DEFAULT_EVENT_DURATION_MINUTES = 30;
const CHINA_TZ_OFFSET = "+08:00";

let listener: ChildProcess | undefined;
let restartCount = 0;
let stopping = false;
const handledMessageIds = new Set<string>();

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

interface CalendarIntent {
  summary: string;
  start: string;
  end: string;
}

interface NormalizedMessageEvent {
  type: string;
  messageId?: string;
  chatId?: string;
  senderId?: string;
  senderType?: string;
  messageType?: string;
  text: string;
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

function isCalendarCreateIntent(text: string) {
  return /(创建|新建|安排|预约|约).{0,12}(日程|日历|会议|会)/i.test(text);
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

async function createCalendarEventFromText(text: string) {
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
    await runLarkCli(
      [
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
      ],
      "user",
    );
    return formatCalendarResult(intent);
  } catch (error) {
    console.error("创建日程失败:", error);
    return `我收到了创建日程请求，但飞书日历创建失败：${sanitizeError(error)}`;
  }
}

function normalizeEvent(raw: IncomingMessageEvent): NormalizedMessageEvent | undefined {
  const type = raw.type || raw.header?.event_type;
  if (type !== EVENT_TYPE) {
    return undefined;
  }

  const message = raw.event?.message;
  const sender = raw.event?.sender;

  return {
    type,
    messageId: raw.message_id || raw.id || message?.message_id,
    chatId: raw.chat_id || message?.chat_id,
    senderId: raw.sender_id || sender?.sender_id?.open_id,
    messageType: raw.message_type || message?.message_type,
    senderType: "user",
    text: normalizeContent(raw.content ?? message?.content),
  };
}

async function buildReply(event: NormalizedMessageEvent) {
  const text = event.text;

  if (!text) {
    return "我收到了一条非文本消息。现在我主要处理文字指令，可以直接发项目需求给我。";
  }

  if (text.includes("你好") || text.toLowerCase().includes("hello")) {
    return (
      "你好！我是 ProjectPilot 项目管理助手，我已经在线。\n\n" +
      "我可以帮你：\n" +
      "1. 自动创建项目空间和知识库\n" +
      "2. 拆解项目节点和任务\n" +
      "3. 会议纪要自动转待办\n" +
      "4. 项目进度和风险自动提醒\n\n" +
      "你可以这样说：帮我创建一个飞书比赛项目，目标 5 月 7 日前完成 Demo，July 负责产品，A 负责开发。"
    );
  }

  if (text.includes("创建项目")) {
    return "好的，我正在解析你的项目需求。请补充项目名称、目标、截止时间、成员和分工信息。";
  }

  if (text.includes("在吗") || text.includes("在线") || text.includes("ping")) {
    return "我在，监听进程正常收到你的消息。";
  }

  const calendarReply = await createCalendarEventFromText(text);
  if (calendarReply) {
    return calendarReply;
  }

  try {
    const llmReply = await callLlm(event);
    if (llmReply) {
      return llmReply;
    }
  } catch (error) {
    console.error("大模型回复失败，使用兜底回复:", error);
  }

  return "收到。我现在已经能持续监听飞书消息了；项目创建、任务拆解和会议待办这几类需求可以继续发给我。";
}

async function handleMessage(raw: IncomingMessageEvent) {
  const event = normalizeEvent(raw);
  if (!event) {
    return;
  }

  await handleNormalizedMessage(event);
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

  const reply = await buildReply(event);
  await sendMessage(event, reply);
  console.log(`已回复 message_id=${event.messageId || "(none)"}`);
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
  const sender = message.sender as { id?: string; sender_type?: string } | undefined;
  const senderType = sender?.sender_type;

  if (!messageId || senderType === "app") {
    return undefined;
  }

  return {
    type: EVENT_TYPE,
    messageId,
    chatId,
    senderId: sender?.id,
    senderType,
    messageType: typeof message.msg_type === "string" ? message.msg_type : undefined,
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
      EVENT_TYPE,
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
        handleMessage(JSON.parse(trimmed)).catch((error) => {
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
