import {
  MeetingExtractionResult,
  TopicMatchResult,
  TopicMatchResultSchema,
  TopicSuggestedActionSchema
} from "../schemas";
import { LlmClient } from "../services/llm/llmClient";
import { KnowledgeBaseRow, MeetingRow, Repositories } from "../services/store/repositories";
import { readPrompt } from "../utils/prompts";

const CurrentTranscriptLimit = 2400;
const CandidateTranscriptLimit = 1200;

type TopicClusteringContext = {
  current_meeting: ReturnType<typeof meetingDigest>;
  extraction: {
    meeting_summary: string;
    topic_keywords: string[];
    key_decisions: MeetingExtractionResult["key_decisions"];
    risks: MeetingExtractionResult["risks"];
    action_items: Array<{
      title: string;
      description: string | null;
      owner: string | null;
      due_date: string | null;
      evidence: string;
    }>;
    calendar_drafts: Array<{
      title: string;
      start_time: string | null;
      participants: string[];
      agenda: string | null;
      evidence: string;
    }>;
    source_mentions: MeetingExtractionResult["source_mentions"];
    confidence: number;
  };
  candidate_meetings: Array<ReturnType<typeof meetingDigest>>;
  existing_knowledge_bases: Array<ReturnType<typeof knowledgeBaseDigest>>;
};

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

function compactText(value: string | null, maxLength: number): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return null;
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.filter((item): item is string => typeof item === "string"))
    : [];
}

function clampScore(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function meetingDigest(meeting: MeetingRow, transcriptLimit: number) {
  return {
    id: meeting.id,
    title: meeting.title,
    started_at: meeting.started_at,
    ended_at: meeting.ended_at,
    organizer: meeting.organizer,
    participants: parseStringArray(meeting.participants_json),
    summary: meeting.summary,
    keywords: parseStringArray(meeting.keywords_json),
    archive_status: meeting.archive_status,
    matched_kb_id: meeting.matched_kb_id,
    match_score: meeting.match_score,
    minutes_url: meeting.minutes_url,
    transcript_url: meeting.transcript_url,
    transcript_excerpt: compactText(meeting.transcript_text, transcriptLimit)
  };
}

function parseKnowledgeBaseMeetingIds(knowledgeBase: KnowledgeBaseRow): string[] {
  return parseStringArray(knowledgeBase.created_from_meetings_json);
}

function knowledgeBaseDigest(
  knowledgeBase: KnowledgeBaseRow,
  meetingsById: Map<string, MeetingRow>
) {
  const createdFromMeetingIds = parseKnowledgeBaseMeetingIds(knowledgeBase);
  const sourceMeetings = createdFromMeetingIds
    .map((meetingId) => meetingsById.get(meetingId))
    .filter((meeting): meeting is MeetingRow => meeting !== undefined)
    .map((meeting) => meetingDigest(meeting, CandidateTranscriptLimit));

  return {
    id: knowledgeBase.id,
    name: knowledgeBase.name,
    goal: knowledgeBase.goal,
    description: knowledgeBase.description,
    owner: knowledgeBase.owner,
    status: knowledgeBase.status,
    related_keywords: parseStringArray(knowledgeBase.related_keywords_json),
    created_from_meetings: createdFromMeetingIds,
    source_meeting_summaries: sourceMeetings
  };
}

function extractionDigest(extraction: MeetingExtractionResult): TopicClusteringContext["extraction"] {
  return {
    meeting_summary: extraction.meeting_summary,
    topic_keywords: extraction.topic_keywords,
    key_decisions: extraction.key_decisions,
    risks: extraction.risks,
    action_items: extraction.action_items.map((item) => ({
      title: item.title,
      description: item.description,
      owner: item.owner,
      due_date: item.due_date,
      evidence: item.evidence
    })),
    calendar_drafts: extraction.calendar_drafts.map((draft) => ({
      title: draft.title,
      start_time: draft.start_time,
      participants: draft.participants,
      agenda: draft.agenda,
      evidence: draft.evidence
    })),
    source_mentions: extraction.source_mentions,
    confidence: extraction.confidence
  };
}

function buildTopicClusteringContext(input: {
  repos: Repositories;
  meeting: MeetingRow;
  extraction: MeetingExtractionResult;
}): TopicClusteringContext {
  const meetings = input.repos.listMeetings();
  const meetingsById = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  const candidateMeetings = meetings
    .filter((meeting) => meeting.id !== input.meeting.id)
    .filter((meeting) => meeting.archive_status !== "rejected")
    .map((meeting) => meetingDigest(meeting, CandidateTranscriptLimit));
  const knowledgeBases = input.repos
    .listKnowledgeBases()
    .filter((knowledgeBase) => ["active", "candidate"].includes(knowledgeBase.status))
    .map((knowledgeBase) => knowledgeBaseDigest(knowledgeBase, meetingsById));

  return {
    current_meeting: meetingDigest(input.meeting, CurrentTranscriptLimit),
    extraction: extractionDigest(input.extraction),
    candidate_meetings: candidateMeetings,
    existing_knowledge_bases: knowledgeBases
  };
}

function buildTopicClusteringUserPrompt(context: TopicClusteringContext): string {
  return [
    "请根据下面的 topic_clustering_context 输出 TopicMatchResult JSON。",
    "代码没有预先计算相关度，也不会用关键词命中、标题重叠、参会人重叠或来源重叠来替你做最终判断。",
    "你需要像 Claude 使用上下文和工具一样，理解会议内容、历史会议、已有知识库摘要和用户意图，然后决定是否 ask_append、ask_create、observe 或 no_action。",
    "输出 JSON 字段：current_meeting_id、matched_kb_id、matched_kb_name、score、match_reasons、suggested_action、candidate_meeting_ids。",
    "topic_clustering_context:",
    JSON.stringify(context, null, 2)
  ].join("\n\n");
}

function normalizeTopicMatch(
  raw: unknown,
  context: TopicClusteringContext,
  currentMeetingId: string
): TopicMatchResult {
  const record = asRecord(raw);
  const actionRaw = firstString([record.suggested_action]);
  const action = TopicSuggestedActionSchema.safeParse(actionRaw).success
    ? (actionRaw as TopicMatchResult["suggested_action"])
    : "observe";
  const matchedKbId = firstString([record.matched_kb_id]);
  const matchedKnowledgeBase = matchedKbId
    ? context.existing_knowledge_bases.find((knowledgeBase) => knowledgeBase.id === matchedKbId)
    : undefined;
  const candidateMeetingIds = unique(safeStringArray(record.candidate_meeting_ids));
  const reasons = safeStringArray(record.match_reasons);

  return TopicMatchResultSchema.parse({
    current_meeting_id: currentMeetingId,
    matched_kb_id: matchedKbId,
    matched_kb_name: firstString([record.matched_kb_name, matchedKnowledgeBase?.name]),
    score: clampScore(record.score, action === "no_action" ? 0.4 : 0.6),
    match_reasons:
      reasons.length > 0 ? reasons : ["LLM returned a structural topic decision without reasons"],
    suggested_action: action,
    candidate_meeting_ids:
      candidateMeetingIds.length > 0 ? candidateMeetingIds : [currentMeetingId]
  });
}

function fallbackTopicMatch(
  context: TopicClusteringContext,
  currentMeetingId: string,
  error: unknown
): TopicMatchResult {
  const hasHistoricalContext =
    context.candidate_meetings.length > 0 || context.existing_knowledge_bases.length > 0;
  const action = hasHistoricalContext ? "observe" : "no_action";
  const message = error instanceof Error ? error.message : String(error);

  return TopicMatchResultSchema.parse({
    current_meeting_id: currentMeetingId,
    matched_kb_id: null,
    matched_kb_name: null,
    score: hasHistoricalContext ? 0.6 : 0.4,
    match_reasons: [`LLM unavailable: topic clustering skipped (${message})`],
    suggested_action: action,
    candidate_meeting_ids: [currentMeetingId]
  });
}

export async function runTopicClusteringAgent(input: {
  repos: Repositories;
  meeting: MeetingRow;
  extraction: MeetingExtractionResult;
  llm?: LlmClient;
}): Promise<TopicMatchResult> {
  const context = buildTopicClusteringContext(input);
  if (!input.llm) {
    return fallbackTopicMatch(context, input.meeting.id, new Error("no LLM client provided"));
  }

  try {
    const raw = await input.llm.generateJson<unknown>({
      systemPrompt: readPrompt("topicClustering.md"),
      userPrompt: buildTopicClusteringUserPrompt(context),
      schemaName: "TopicMatchResult"
    });

    return normalizeTopicMatch(raw, context, input.meeting.id);
  } catch (error) {
    return fallbackTopicMatch(context, input.meeting.id, error);
  }
}
