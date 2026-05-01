import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { MeetingExtractionResult, MeetingExtractionResultSchema } from "../schemas";
import { LlmClient } from "../services/llm/llmClient";
import { MeetingRow } from "../services/store/repositories";

const CalendarIntentWords = ["会议", "访谈", "评审", "同步", "沟通"];
const CalendarSignalWords = ["截止", "评审", "分享", "演示", "发布", "复盘", "会面", "里程碑"];
const CalendarReminderWords = ["截止", "提醒", "到期", "里程碑"];
const CalendarReviewWords = ["评审", "复盘"];
const CalendarShareWords = ["分享", "演示", "发布"];

function readPrompt(name: string): string {
  return readFileSync(join(process.cwd(), "src/prompts", name), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asMeetingExtractionObject(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return (
      raw.find(
        (item) =>
          isRecord(item) &&
          (Object.prototype.hasOwnProperty.call(item, "meeting_summary") ||
            Object.prototype.hasOwnProperty.call(item, "action_items") ||
            Object.prototype.hasOwnProperty.call(item, "calendar_drafts"))
      ) ?? raw
    );
  }

  return raw;
}

function hasCalendarIntent(value: string): boolean {
  return CalendarIntentWords.some((word) => value.includes(word));
}

function looksLikeCalendarReminder(draft: Record<string, unknown>): boolean {
  const text = [draft.title, draft.agenda, draft.evidence]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const hasCalendarSignal = CalendarSignalWords.some((word) => text.includes(word));
  const hasTimeSignal =
    typeof draft.start_time === "string" ||
    /(\d{1,2}\s*[月/-]\s*\d{1,2})|(\d{1,2}\s*点)|(中午|上午|下午|晚上|今晚|明天|后天|周[一二三四五六日天])/u.test(
      text
    );

  return hasCalendarSignal && hasTimeSignal;
}

function normalizeCalendarTitle(title: string, context: string): string {
  if (hasCalendarIntent(title)) {
    return title;
  }

  if (CalendarReviewWords.some((word) => context.includes(word))) {
    return `${title}评审`;
  }

  if (CalendarShareWords.some((word) => context.includes(word))) {
    return `${title}同步`;
  }

  if (CalendarReminderWords.some((word) => context.includes(word))) {
    return `${title}提醒同步`;
  }

  return `${title}会议`;
}

function normalizeCalendarDrafts(raw: unknown): unknown {
  const value = asMeetingExtractionObject(raw);
  if (!isRecord(value) || !Array.isArray(value.calendar_drafts)) {
    return value;
  }

  return {
    ...value,
    calendar_drafts: value.calendar_drafts.map((draft) => {
      if (!isRecord(draft) || typeof draft.title !== "string") {
        return draft;
      }

      const haystack = [draft.title, draft.agenda, draft.evidence]
        .filter((field): field is string => typeof field === "string")
        .join(" ");
      if (!looksLikeCalendarReminder(draft)) {
        return draft;
      }

      return {
        ...draft,
        title: normalizeCalendarTitle(draft.title, haystack)
      };
    })
  };
}

function normalizeRawExtraction(raw: unknown): unknown {
  return normalizeCalendarDrafts(asMeetingExtractionObject(raw));
}

function briefSchemaError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
      .join("; ");
  }

  return error instanceof Error ? error.message : String(error);
}

async function repairExtractionWithLlm(input: {
  llm: LlmClient;
  systemPrompt: string;
  userPrompt: string;
  raw: unknown;
  error: unknown;
}): Promise<MeetingExtractionResult> {
  const repaired = await input.llm.generateJson<unknown>({
    systemPrompt: input.systemPrompt,
    userPrompt: [
      "上一次输出没有通过 MeetingExtractionResult schema 校验。",
      "请在保留原始信息的基础上修正为项目期望的顶层 JSON object。",
      "不要返回 array 作为顶层，不要 Markdown，不要解释，不要省略必填字段。",
      "如果 calendar_drafts 中的事项是明确带时间的日程、截止提醒、评审、分享、演示、发布、复盘、同步、会面或里程碑，title、agenda 或 evidence 必须包含会议、访谈、评审、同步或沟通意图词。",
      "如果只是任务截止且没有日程提醒意图，不要放进 calendar_drafts。",
      `schema_error: ${briefSchemaError(input.error)}`,
      "invalid_output:",
      JSON.stringify(input.raw),
      "",
      "original_meeting_input:",
      input.userPrompt
    ].join("\n"),
    schemaName: "MeetingExtractionResult"
  });

  return MeetingExtractionResultSchema.parse(normalizeRawExtraction(repaired));
}

export async function runMeetingExtractionAgent(input: {
  meeting: MeetingRow;
  llm: LlmClient;
}): Promise<MeetingExtractionResult> {
  const systemPrompt = readPrompt("meetingExtraction.md");
  const userPrompt = [
    `title: ${input.meeting.title}`,
    `organizer: ${input.meeting.organizer ?? "unknown"}`,
    `participants: ${input.meeting.participants_json}`,
    "transcript:",
    input.meeting.transcript_text
  ].join("\n");
  const raw = await input.llm.generateJson<unknown>({
    systemPrompt,
    userPrompt,
    schemaName: "MeetingExtractionResult"
  });

  const normalized = normalizeRawExtraction(raw);
  const parsed = MeetingExtractionResultSchema.safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }

  return repairExtractionWithLlm({
    llm: input.llm,
    systemPrompt,
    userPrompt,
    raw,
    error: parsed.error
  });
}
