import { z } from "zod";
import { AppConfig } from "../config";
import { KnowledgeUpdateSchema } from "../schemas";
import {
  ActionItemRow,
  CalendarDraftRow,
  ConfirmationRequestRow,
  KnowledgeBaseRow,
  KnowledgeUpdateRow,
  MeetingRow,
  Repositories
} from "../services/store/repositories";
import { nowIso } from "../utils/dates";
import {
  formatMeetingReference,
  formatUserForDisplay,
  formatUserListForDisplay
} from "../utils/display";
import { createId } from "../utils/id";

const KeyDecisionSchema = z.object({
  decision: z.string().min(1),
  evidence: z.string().min(1)
});

const RiskSchema = z.object({
  risk: z.string().min(1),
  evidence: z.string().min(1)
});

const AppendMeetingPayloadSchema = z.object({
  kb_id: z.string().min(1),
  kb_name: z.string().nullable().optional(),
  meeting_id: z.string().min(1),
  meeting_summary: z.string().min(1).optional(),
  key_decisions: z.array(KeyDecisionSchema).optional(),
  risks: z.array(RiskSchema).optional(),
  topic_keywords: z.array(z.string()).optional(),
  match_reasons: z.array(z.string()).optional(),
  score: z.number().min(0).max(1).optional(),
  reason: z.string().min(1).optional()
});

type AppendMeetingPayload = z.infer<typeof AppendMeetingPayloadSchema>;

export interface AppendMeetingToKnowledgeBaseWorkflowResult {
  confirmation: ConfirmationRequestRow;
  knowledge_base: KnowledgeBaseRow;
  knowledge_update: KnowledgeUpdateRow;
  markdown: string;
  dry_run: boolean;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parsePayload(request: ConfirmationRequestRow): AppendMeetingPayload {
  const original = JSON.parse(request.original_payload_json) as unknown;
  const edited = request.edited_payload_json
    ? (JSON.parse(request.edited_payload_json) as unknown)
    : {};
  return AppendMeetingPayloadSchema.parse({
    ...asObject(original),
    ...asObject(edited)
  });
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function bulletList(values: string[], fallback: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function renderActionIndex(actions: ActionItemRow[], meeting: MeetingRow): string[] {
  return actions.map((action) => {
    const owner = action.owner ? `，负责人 ${formatUserForDisplay(action.owner)}` : "";
    const due = action.due_date ? `，截止 ${action.due_date}` : "";
    return `${action.title}${owner}${due}（来源${formatMeetingReference(meeting, {
      preferredLink: "minutes"
    })}）`;
  });
}

function renderCalendarIndex(calendars: CalendarDraftRow[], meeting: MeetingRow): string[] {
  return calendars.map((calendar) => {
    const time = calendar.start_time ? `，时间 ${calendar.start_time}` : "";
    const participants = formatUserListForDisplay(parseStringArray(calendar.participants_json));
    const participantText = participants.length > 0 ? `，参与人 ${participants.join("、")}` : "";
    return `${calendar.title}${time}${participantText}（来源${formatMeetingReference(meeting, {
      preferredLink: "minutes"
    })}）`;
  });
}

function transcriptReference(meeting: MeetingRow): string {
  const reference = formatMeetingReference(meeting, {
    preferredLink: "transcript"
  });
  if (
    meeting.transcript_url ||
    meeting.minutes_url ||
    /^https?:\/\//i.test(meeting.external_meeting_id ?? "")
  ) {
    return reference;
  }
  return `${reference}，transcript_text 已存入本地 meetings 表`;
}

function renderAppendMarkdown(input: {
  knowledgeBase: KnowledgeBaseRow;
  meeting: MeetingRow;
  payload: AppendMeetingPayload;
  actions: ActionItemRow[];
  calendars: CalendarDraftRow[];
}): string {
  const summary = input.payload.meeting_summary ?? input.meeting.summary ?? "暂无摘要";
  const decisions = (input.payload.key_decisions ?? []).map(
    (decision) => `${decision.decision}（证据：${decision.evidence}）`
  );
  const risks = (input.payload.risks ?? []).map((risk) => `${risk.risk}（证据：${risk.evidence}）`);

  return [
    `# 增量更新：${input.meeting.title}`,
    "",
    `知识库：${input.knowledgeBase.name}`,
    `来源会议：${formatMeetingReference(input.meeting, {
      preferredLink: "minutes"
    })}`,
    "",
    "## 会议摘要",
    summary,
    "",
    "## 关键结论",
    bulletList(decisions, "暂无关键结论"),
    "",
    "## 风险、问题与待验证假设",
    bulletList(risks, "暂无风险、问题与待验证假设"),
    "",
    "## 待办索引",
    bulletList(renderActionIndex(input.actions, input.meeting), "暂无待办"),
    "",
    "## 日程索引",
    bulletList(renderCalendarIndex(input.calendars, input.meeting), "暂无日程"),
    "",
    "## 会议转写记录引用",
    `- ${transcriptReference(input.meeting)}`,
    "",
    "## 匹配依据",
    bulletList(input.payload.match_reasons ?? [], "暂无匹配依据")
  ].join("\n");
}

export async function appendMeetingToKnowledgeBaseWorkflow(input: {
  repos: Repositories;
  config?: AppConfig;
  confirmationId: string;
}): Promise<AppendMeetingToKnowledgeBaseWorkflowResult> {
  const request = input.repos.getConfirmationRequest(input.confirmationId);
  if (!request) {
    throw new Error(`Confirmation request not found: ${input.confirmationId}`);
  }
  if (request.request_type !== "append_meeting") {
    throw new Error(`Confirmation request is not append_meeting: ${request.request_type}`);
  }

  const payload = parsePayload(request);
  const meeting = input.repos.getMeeting(payload.meeting_id);
  if (!meeting) {
    throw new Error(`Meeting not found: ${payload.meeting_id}`);
  }
  const knowledgeBase = input.repos.getKnowledgeBase(payload.kb_id);
  if (!knowledgeBase) {
    throw new Error(`Knowledge base not found: ${payload.kb_id}`);
  }
  if (!["active", "candidate"].includes(knowledgeBase.status)) {
    throw new Error(`Knowledge base is not appendable: ${knowledgeBase.status}`);
  }

  const actions = input.repos
    .listActionItems()
    .filter((action) => action.meeting_id === meeting.id);
  const calendars = input.repos
    .listCalendarDrafts()
    .filter((calendar) => calendar.meeting_id === meeting.id);
  const markdown = renderAppendMarkdown({
    knowledgeBase,
    meeting,
    payload,
    actions,
    calendars
  });

  const existingMeetingIds = parseStringArray(knowledgeBase.created_from_meetings_json);
  const nextMeetingIds = unique([...existingMeetingIds, meeting.id]);
  const nextKeywords = unique([
    ...parseStringArray(knowledgeBase.related_keywords_json),
    ...parseStringArray(meeting.keywords_json),
    ...(payload.topic_keywords ?? [])
  ]);

  input.repos.updateKnowledgeBaseAfterAppend({
    id: knowledgeBase.id,
    related_keywords_json: JSON.stringify(nextKeywords),
    created_from_meetings_json: JSON.stringify(nextMeetingIds)
  });

  const update = KnowledgeUpdateSchema.parse({
    update_id: createId("kbu"),
    kb_id: knowledgeBase.id,
    update_type: "meeting_added",
    summary: `追加会议到知识库：${meeting.title}`,
    source_ids: [meeting.id],
    before: `已有会议：${existingMeetingIds.join(", ") || "暂无"}`,
    after: markdown,
    created_by: "agent",
    confirmed_by: request.recipient,
    created_at: nowIso()
  });

  const knowledgeUpdate = input.repos.createKnowledgeUpdate({
    id: update.update_id,
    kb_id: update.kb_id,
    update_type: update.update_type,
    summary: update.summary,
    source_ids_json: JSON.stringify(update.source_ids),
    before_text: update.before,
    after_text: update.after,
    created_by: update.created_by,
    confirmed_by: update.confirmed_by,
    created_at: update.created_at
  });

  input.repos.updateMeetingTopic({
    id: meeting.id,
    matched_kb_id: knowledgeBase.id,
    match_score: payload.score ?? meeting.match_score ?? 0.78,
    archive_status: "archived"
  });

  input.repos.updateConfirmationRequest({
    id: request.id,
    status: "executed",
    executed_at: nowIso(),
    error: null
  });

  return {
    confirmation: input.repos.getConfirmationRequest(request.id) ?? request,
    knowledge_base: input.repos.getKnowledgeBase(knowledgeBase.id) ?? knowledgeBase,
    knowledge_update: knowledgeUpdate,
    markdown,
    dry_run: input.config?.feishuDryRun ?? true
  };
}
