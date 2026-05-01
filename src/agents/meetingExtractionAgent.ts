import { ZodError } from "zod";
import { MeetingExtractionResult, MeetingExtractionResultSchema } from "../schemas";
import { LlmClient } from "../services/llm/llmClient";
import { MeetingRow } from "../services/store/repositories";
import {
  addMinutesWithChinaOffset,
  isIsoDateOnly,
  isIsoDateTimeWithHour,
  resolveDateExpression,
  resolveDateTimeExpression
} from "../utils/dates";
import { readPrompt } from "../utils/prompts";

const CalendarIntentWords = ["会议", "访谈", "评审", "同步", "沟通"];
const CalendarSignalWords = ["截止", "评审", "分享", "演示", "发布", "复盘", "会面", "里程碑"];
const CalendarReminderWords = ["截止", "提醒", "到期", "里程碑"];
const CalendarReviewWords = ["评审", "复盘"];
const CalendarShareWords = ["分享", "演示", "发布"];
const UnsupportedOwnershipReasonPatterns = [
  /接收人/,
  /收件人/,
  /组织者/,
  /主持人身份/,
  /发送.{0,6}卡片/,
  /用户据此/,
  /默认/
];
const UnsupportedCommitmentPhrases = [/用户据此.{0,12}(认领|承诺)/, /据此.{0,12}(认领|承诺)/];

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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function addMissingField(fields: string[], field: string): string[] {
  return fields.includes(field) ? fields : [...fields, field];
}

function removeMissingField(fields: string[], field: string): string[] {
  return fields.filter((item) => item !== field);
}

function textFromFields(fields: unknown[]): string {
  return fields.filter((field): field is string => typeof field === "string").join(" ");
}

function normalizeActionDates(input: {
  baseIso: string | null;
  action: Record<string, unknown>;
}): Record<string, unknown> {
  const evidenceText = textFromFields([
    input.action.title,
    input.action.description,
    input.action.evidence,
    input.action.suggested_reason
  ]);
  const dueDate =
    resolveDateExpression({
      baseIso: input.baseIso,
      text: evidenceText
    }) ??
    resolveDateExpression({
      baseIso: input.baseIso,
      text: textFromFields([input.action.due_date])
    });
  if (dueDate === null) {
    if (
      typeof input.action.due_date === "string" &&
      !/^\d{4}-\d{2}-\d{2}$/.test(input.action.due_date)
    ) {
      return {
        ...input.action,
        due_date: null,
        missing_fields: addMissingField(asStringArray(input.action.missing_fields), "due_date")
      };
    }

    return input.action;
  }

  return {
    ...input.action,
    due_date: dueDate,
    missing_fields: removeMissingField(asStringArray(input.action.missing_fields), "due_date")
  };
}

function normalizeCalendarDates(input: {
  baseIso: string | null;
  draft: Record<string, unknown>;
}): Record<string, unknown> {
  const evidenceText = textFromFields([
    input.draft.title,
    input.draft.agenda,
    input.draft.evidence
  ]);
  const existingStartTime =
    typeof input.draft.start_time === "string" ? input.draft.start_time : null;
  const evidenceResolution = resolveDateTimeExpression({
    baseIso: input.baseIso,
    text: evidenceText
  });
  const resolution =
    evidenceResolution.date !== null
      ? evidenceResolution
      : resolveDateTimeExpression({
          baseIso: input.baseIso,
          text: textFromFields([existingStartTime])
        });
  const missingFields = asStringArray(input.draft.missing_fields);

  if (resolution.start_time !== null) {
    const durationMinutes =
      typeof input.draft.duration_minutes === "number" ? input.draft.duration_minutes : null;
    const endTime =
      durationMinutes === null
        ? input.draft.end_time
        : addMinutesWithChinaOffset(resolution.start_time, durationMinutes);

    return {
      ...input.draft,
      start_time: resolution.start_time,
      end_time: endTime,
      missing_fields: removeMissingField(missingFields, "start_time")
    };
  }

  if (resolution.date !== null && !resolution.has_explicit_hour) {
    return {
      ...input.draft,
      start_time: null,
      end_time: null,
      missing_fields: addMissingField(missingFields, "start_time")
    };
  }

  if (
    existingStartTime !== null &&
    (isIsoDateOnly(existingStartTime) || !isIsoDateTimeWithHour(existingStartTime))
  ) {
    return {
      ...input.draft,
      start_time: null,
      end_time: null,
      missing_fields: addMissingField(missingFields, "start_time")
    };
  }

  return input.draft;
}

function normalizeRelativeDates(raw: unknown, baseIso: string | null): unknown {
  const value = asMeetingExtractionObject(raw);
  if (!isRecord(value)) {
    return value;
  }

  const actionItems = Array.isArray(value.action_items)
    ? value.action_items.map((item) =>
        isRecord(item) ? normalizeActionDates({ baseIso, action: item }) : item
      )
    : value.action_items;
  const calendarDrafts = Array.isArray(value.calendar_drafts)
    ? value.calendar_drafts.map((draft) =>
        isRecord(draft) ? normalizeCalendarDates({ baseIso, draft }) : draft
      )
    : value.calendar_drafts;

  return {
    ...value,
    action_items: actionItems,
    calendar_drafts: calendarDrafts
  };
}

function normalizeRawExtraction(raw: unknown, baseIso: string | null): unknown {
  return normalizeRelativeDates(normalizeCalendarDrafts(asMeetingExtractionObject(raw)), baseIso);
}

function missingFieldsWithOwner(fields: string[]): string[] {
  return fields.includes("owner") ? fields : [...fields, "owner"];
}

function hasOwnerEvidence(input: {
  owner: string;
  evidence: string;
  suggestedReason: string;
}): boolean {
  const text = `${input.evidence} ${input.suggestedReason}`;
  if (!text.includes(input.owner)) {
    return false;
  }

  return !UnsupportedOwnershipReasonPatterns.some((pattern) => pattern.test(text));
}

function sanitizeReason(input: { owner: string | null; suggestedReason: string }): string {
  if (input.owner !== null) {
    return input.suggestedReason;
  }

  if (UnsupportedCommitmentPhrases.some((pattern) => pattern.test(input.suggestedReason))) {
    return "会议证据中未明确负责人，需确认后再创建待办。";
  }

  return input.suggestedReason;
}

function sanitizeActionOwnership(extraction: MeetingExtractionResult): MeetingExtractionResult {
  return {
    ...extraction,
    action_items: extraction.action_items.map((item) => {
      const owner =
        item.owner !== null &&
        hasOwnerEvidence({
          owner: item.owner,
          evidence: item.evidence,
          suggestedReason: item.suggested_reason
        })
          ? item.owner
          : null;

      return {
        ...item,
        owner,
        suggested_reason: sanitizeReason({
          owner,
          suggestedReason: item.suggested_reason
        }),
        missing_fields:
          owner === null ? missingFieldsWithOwner(item.missing_fields) : item.missing_fields
      };
    })
  };
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
  baseIso: string | null;
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

  return sanitizeActionOwnership(
    MeetingExtractionResultSchema.parse(normalizeRawExtraction(repaired, input.baseIso))
  );
}

export async function runMeetingExtractionAgent(input: {
  meeting: MeetingRow;
  llm: LlmClient;
}): Promise<MeetingExtractionResult> {
  const systemPrompt = readPrompt("meetingExtraction.md");
  const userPrompt = [
    `title: ${input.meeting.title}`,
    `meeting_started_at: ${input.meeting.started_at ?? "unknown"}`,
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

  const normalized = normalizeRawExtraction(raw, input.meeting.started_at);
  const parsed = MeetingExtractionResultSchema.safeParse(normalized);
  if (parsed.success) {
    return sanitizeActionOwnership(parsed.data);
  }

  return repairExtractionWithLlm({
    llm: input.llm,
    systemPrompt,
    userPrompt,
    baseIso: input.meeting.started_at,
    raw,
    error: parsed.error
  });
}
