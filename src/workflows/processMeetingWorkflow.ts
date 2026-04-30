import {
  DryRunConfirmationCard,
  ManualMeetingInput,
  MeetingExtractionResult,
  TopicMatchResult
} from "../schemas";
import { runCalendarAgent } from "../agents/calendarAgent";
import { buildConfirmationCardFromRequest } from "../agents/cardInteractionAgent";
import { runMeetingExtractionAgent } from "../agents/meetingExtractionAgent";
import { runPersonalActionAgent } from "../agents/personalActionAgent";
import { runTopicClusteringAgent } from "../agents/topicClusteringAgent";
import { LlmClient } from "../services/llm/llmClient";
import { createConfirmationRequest } from "../services/confirmationService";
import { ConfirmationRequestRow, Repositories } from "../services/store/repositories";
import { formatMeetingReference } from "../utils/display";
import { createId } from "../utils/id";

const KnowledgeBaseActionIntentPatterns = [
  /创建.{0,12}知识库/,
  /整理.{0,12}知识库/,
  /归档到.{0,12}知识库/,
  /建立.{0,12}知识库/
];
const PersonalWorkspaceName = "Henry 个人工作台";
const PersonalKnowledgeBaseMode = "personal";

export interface ProcessMeetingResult {
  meeting_id: string;
  extraction: MeetingExtractionResult;
  confirmation_requests: string[];
  topic_match: TopicMatchResult;
}

export interface ProcessMeetingTextResult extends ProcessMeetingResult {
  personal_workspace: {
    mode: "personal";
    name: string;
    recipient: string | null;
  };
  confirmation_summary: Record<ConfirmationRequestRow["request_type"], number>;
  confirmation_cards: DryRunConfirmationCard[];
}

function suggestTopicName(input: { title: string; keywords: string[] }): string {
  const primaryKeywords = input.keywords.slice(0, 2).join("");
  return primaryKeywords ? `${primaryKeywords}主题知识库` : `${input.title}主题知识库`;
}

function suggestGoal(topicName: string): string {
  return `沉淀${topicName}相关会议结论、行动项、日程与资料来源，形成 Henry 个人可持续更新的项目知识库。`;
}

function defaultKnowledgeBaseStructure(): string[] {
  return [
    "00 Henry 个人工作台 / 总览",
    "01 会议总结",
    "02 会议转写记录",
    "03 待办与日程索引"
  ];
}

function isKnowledgeBaseCreationAction(
  item: MeetingExtractionResult["action_items"][number]
): boolean {
  const text = `${item.title} ${item.description ?? ""}`;
  return KnowledgeBaseActionIntentPatterns.some((pattern) => pattern.test(text));
}

function actionConfirmationRecipient(input: {
  recipient: string | null;
  organizer: string | null;
}): string | null {
  return input.recipient?.startsWith("ou_") ? input.recipient : (input.organizer ?? null);
}

function meetingSourcePayload(meeting: {
  id: string;
  title: string;
  external_meeting_id: string | null;
  minutes_url: string | null;
  transcript_url: string | null;
}): Record<string, unknown> {
  return {
    meeting_reference: formatMeetingReference(meeting, {
      preferredLink: "minutes",
      hideInternalId: true
    }),
    meeting_title: meeting.title,
    minutes_url: meeting.minutes_url,
    transcript_url: meeting.transcript_url,
    external_meeting_id: meeting.external_meeting_id
  };
}

function appendMeetingPayload(input: {
  meeting: {
    id: string;
    title: string;
    external_meeting_id: string | null;
    minutes_url: string | null;
    transcript_url: string | null;
  };
  kbId: string;
  kbName: string | null;
  extraction: MeetingExtractionResult;
  topicMatch: TopicMatchResult;
}): Record<string, unknown> {
  return {
    kb_id: input.kbId,
    kb_name: input.kbName,
    meeting_id: input.meeting.id,
    ...meetingSourcePayload(input.meeting),
    meeting_summary: input.extraction.meeting_summary,
    key_decisions: input.extraction.key_decisions,
    risks: input.extraction.risks,
    topic_keywords: input.extraction.topic_keywords,
    match_reasons: input.topicMatch.match_reasons,
    score: input.topicMatch.score,
    topic_match: input.topicMatch,
    reason: "检测到当前会议与已有知识库高度相关，建议确认后追加到知识库。"
  };
}

function meetingReferencesForIds(input: { repos: Repositories; meetingIds: string[] }): string[] {
  return input.meetingIds
    .map((meetingId) => input.repos.getMeeting(meetingId))
    .filter((meeting): meeting is NonNullable<typeof meeting> => meeting !== null)
    .map((meeting) =>
      formatMeetingReference(meeting, {
        preferredLink: "minutes",
        hideInternalId: true
      })
    );
}

function countConfirmationRequests(
  confirmations: ConfirmationRequestRow[]
): Record<ConfirmationRequestRow["request_type"], number> {
  return confirmations.reduce<Record<ConfirmationRequestRow["request_type"], number>>(
    (counts, confirmation) => ({
      ...counts,
      [confirmation.request_type]: counts[confirmation.request_type] + 1
    }),
    {
      action: 0,
      calendar: 0,
      create_kb: 0,
      append_meeting: 0,
      archive_source: 0
    }
  );
}

export async function processMeetingWorkflow(input: {
  repos: Repositories;
  llm: LlmClient;
  meeting: ManualMeetingInput;
}): Promise<ProcessMeetingResult> {
  const meeting = input.repos.createMeeting({
    id: createId("mtg"),
    external_meeting_id: input.meeting.external_meeting_id ?? null,
    title: input.meeting.title,
    started_at: input.meeting.started_at,
    ended_at: input.meeting.ended_at,
    organizer: input.meeting.organizer,
    participants_json: JSON.stringify(input.meeting.participants),
    minutes_url: input.meeting.minutes_url ?? null,
    transcript_url: input.meeting.transcript_url ?? null,
    transcript_text: input.meeting.transcript_text,
    summary: null,
    keywords_json: JSON.stringify([]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 0,
    calendar_count: 0
  });

  const extraction = await runMeetingExtractionAgent({
    meeting,
    llm: input.llm
  });

  input.repos.updateMeetingExtraction({
    id: meeting.id,
    summary: extraction.meeting_summary,
    keywords_json: JSON.stringify(extraction.topic_keywords),
    action_count: extraction.action_items.length,
    calendar_count: extraction.calendar_drafts.length
  });

  const refreshedMeeting = input.repos.getMeeting(meeting.id) ?? meeting;
  const topicMatch = await runTopicClusteringAgent({
    repos: input.repos,
    meeting: refreshedMeeting,
    extraction
  });
  input.repos.updateMeetingTopic({
    id: meeting.id,
    matched_kb_id: topicMatch.matched_kb_id,
    match_score: topicMatch.score,
    archive_status: ["ask_create", "ask_append"].includes(topicMatch.suggested_action)
      ? "suggested"
      : "not_archived"
  });

  const actionItemsForConfirmation =
    topicMatch.suggested_action === "ask_create"
      ? extraction.action_items.filter((item) => !isKnowledgeBaseCreationAction(item))
      : extraction.action_items;

  const actionRecords = await runPersonalActionAgent({
    repos: input.repos,
    meeting,
    actionItems: actionItemsForConfirmation
  });
  const calendarRecords = await runCalendarAgent({
    repos: input.repos,
    meeting,
    calendarDrafts: extraction.calendar_drafts
  });

  const confirmations: ConfirmationRequestRow[] = [];
  for (const record of actionRecords) {
    confirmations.push(
      createConfirmationRequest({
        repos: input.repos,
        requestType: "action",
        targetId: record.row.id,
        recipient: actionConfirmationRecipient({
          recipient: record.recipient,
          organizer: input.meeting.organizer
        }),
        originalPayload: {
          draft: record.draft,
          meeting_id: meeting.id,
          ...meetingSourcePayload(meeting)
        }
      })
    );
  }

  for (const record of calendarRecords) {
    confirmations.push(
      createConfirmationRequest({
        repos: input.repos,
        requestType: "calendar",
        targetId: record.row.id,
        recipient: record.recipient,
        originalPayload: {
          draft: record.draft,
          meeting_id: meeting.id,
          ...meetingSourcePayload(meeting)
        }
      })
    );
  }

  if (topicMatch.suggested_action === "ask_create") {
    const topicName = suggestTopicName({
      title: input.meeting.title,
      keywords: extraction.topic_keywords
    });
    confirmations.push(
      createConfirmationRequest({
        repos: input.repos,
        requestType: "create_kb",
        targetId: createId("kb_candidate"),
        recipient: input.meeting.organizer,
        originalPayload: {
          knowledge_base_mode: PersonalKnowledgeBaseMode,
          workspace_name: PersonalWorkspaceName,
          topic_name: topicName,
          suggested_goal: suggestGoal(topicName),
          candidate_meeting_ids: topicMatch.candidate_meeting_ids,
          candidate_meeting_refs: meetingReferencesForIds({
            repos: input.repos,
            meetingIds: topicMatch.candidate_meeting_ids
          }),
          match_reasons: topicMatch.match_reasons,
          score: topicMatch.score,
          default_structure: defaultKnowledgeBaseStructure(),
          topic_match: topicMatch,
          meeting_ids: topicMatch.candidate_meeting_ids,
          reason: "检测到至少两场强相关会议，建议创建主题知识库。"
        }
      })
    );
  }

  if (topicMatch.suggested_action === "ask_append" && topicMatch.matched_kb_id !== null) {
    confirmations.push(
      createConfirmationRequest({
        repos: input.repos,
        requestType: "append_meeting",
        targetId: meeting.id,
        recipient: input.meeting.organizer,
        originalPayload: appendMeetingPayload({
          meeting,
          kbId: topicMatch.matched_kb_id,
          kbName: topicMatch.matched_kb_name,
          extraction,
          topicMatch
        })
      })
    );
  }

  return {
    meeting_id: meeting.id,
    extraction,
    confirmation_requests: confirmations.map((confirmation) => confirmation.id),
    topic_match: topicMatch
  };
}

export async function processMeetingTextToConfirmationsWorkflow(input: {
  repos: Repositories;
  llm: LlmClient;
  meeting: ManualMeetingInput;
  personalWorkspaceName?: string;
}): Promise<ProcessMeetingTextResult> {
  const result = await processMeetingWorkflow(input);
  const confirmations = result.confirmation_requests
    .map((id) => input.repos.getConfirmationRequest(id))
    .filter((confirmation): confirmation is ConfirmationRequestRow => confirmation !== null);

  return {
    ...result,
    personal_workspace: {
      mode: PersonalKnowledgeBaseMode,
      name: input.personalWorkspaceName ?? PersonalWorkspaceName,
      recipient: input.meeting.organizer
    },
    confirmation_summary: countConfirmationRequests(confirmations),
    confirmation_cards: confirmations.map((confirmation) =>
      buildConfirmationCardFromRequest(confirmation)
    )
  };
}
