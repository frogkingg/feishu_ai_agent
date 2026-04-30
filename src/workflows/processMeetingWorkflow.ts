import { ManualMeetingInput, MeetingExtractionResult, TopicMatchResult } from "../schemas";
import { runCalendarAgent } from "../agents/calendarAgent";
import { runMeetingExtractionAgent } from "../agents/meetingExtractionAgent";
import { runPersonalActionAgent } from "../agents/personalActionAgent";
import { runTopicClusteringAgent } from "../agents/topicClusteringAgent";
import { LlmClient } from "../services/llm/llmClient";
import { createConfirmationRequest } from "../services/confirmationService";
import { ConfirmationRequestRow, Repositories } from "../services/store/repositories";
import { createId } from "../utils/id";

const KnowledgeBaseActionIntentPatterns = [
  /创建.{0,12}知识库/,
  /整理.{0,12}知识库/,
  /归档到.{0,12}知识库/,
  /建立.{0,12}知识库/
];

export interface ProcessMeetingResult {
  meeting_id: string;
  extraction: MeetingExtractionResult;
  confirmation_requests: string[];
  topic_match: TopicMatchResult;
}

function suggestTopicName(input: { title: string; keywords: string[] }): string {
  const haystack = [input.title, input.keywords.join(" ")].join(" ");
  if (haystack.includes("无人机")) {
    return "无人机操作方案";
  }

  const primaryKeywords = input.keywords.slice(0, 2).join("");
  return primaryKeywords ? `${primaryKeywords}主题知识库` : `${input.title}主题知识库`;
}

function suggestGoal(topicName: string): string {
  return `沉淀${topicName}相关会议结论、行动项、日程与资料来源，` + "形成可持续更新的项目知识库。";
}

function defaultKnowledgeBaseStructure(): string[] {
  return [
    "00 首页 / 总览",
    "01 整体目标",
    "02 整体分析",
    "03 当前进度",
    "04 风险与决策",
    "05 待办与日程索引",
    "06 单个会议总结",
    "07 会议转写记录"
  ];
}

function isKnowledgeBaseCreationAction(
  item: MeetingExtractionResult["action_items"][number]
): boolean {
  const text = `${item.title} ${item.description ?? ""}`;
  return KnowledgeBaseActionIntentPatterns.some((pattern) => pattern.test(text));
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
    minutes_url: null,
    transcript_url: null,
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
    archive_status: topicMatch.suggested_action === "ask_create" ? "suggested" : "not_archived"
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
        recipient: record.recipient,
        originalPayload: {
          draft: record.draft,
          meeting_id: meeting.id
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
          meeting_id: meeting.id
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
          topic_name: topicName,
          suggested_goal: suggestGoal(topicName),
          candidate_meeting_ids: topicMatch.candidate_meeting_ids,
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

  return {
    meeting_id: meeting.id,
    extraction,
    confirmation_requests: confirmations.map((confirmation) => confirmation.id),
    topic_match: topicMatch
  };
}
