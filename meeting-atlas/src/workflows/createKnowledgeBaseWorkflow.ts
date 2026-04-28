import { z } from "zod";
import { renderKnowledgeBaseMarkdown, runKnowledgeCuratorAgent } from "../agents/knowledgeCuratorAgent";
import { AppConfig } from "../config";
import { KnowledgeBaseDraft, KnowledgeUpdateSchema, TopicMatchResultSchema } from "../schemas";
import { ConfirmationRequestRow, KnowledgeBaseRow, KnowledgeUpdateRow, Repositories } from "../services/store/repositories";
import { nowIso } from "../utils/dates";
import { createId } from "../utils/id";

const CreateKnowledgeBasePayloadSchema = z.object({
  topic_name: z.string().min(1),
  topic_match: TopicMatchResultSchema,
  meeting_ids: z.array(z.string().min(1)).min(2),
  reason: z.string().min(1).optional()
});

type CreateKnowledgeBasePayload = z.infer<typeof CreateKnowledgeBasePayloadSchema>;

export interface CreateKnowledgeBaseWorkflowResult {
  confirmation: ConfirmationRequestRow;
  knowledge_base: KnowledgeBaseRow;
  knowledge_update: KnowledgeUpdateRow;
  draft: KnowledgeBaseDraft;
  markdown: string;
  dry_run: boolean;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parsePayload(request: ConfirmationRequestRow): CreateKnowledgeBasePayload {
  const original = JSON.parse(request.original_payload_json) as unknown;
  const edited = request.edited_payload_json ? (JSON.parse(request.edited_payload_json) as unknown) : {};
  return CreateKnowledgeBasePayloadSchema.parse({
    ...asObject(original),
    ...asObject(edited)
  });
}

export async function createKnowledgeBaseWorkflow(input: {
  repos: Repositories;
  config?: AppConfig;
  confirmationId: string;
}): Promise<CreateKnowledgeBaseWorkflowResult> {
  const request = input.repos.getConfirmationRequest(input.confirmationId);
  if (!request) {
    throw new Error(`Confirmation request not found: ${input.confirmationId}`);
  }
  if (request.request_type !== "create_kb") {
    throw new Error(`Confirmation request is not create_kb: ${request.request_type}`);
  }

  const payload = parsePayload(request);
  const meetings = payload.meeting_ids
    .map((meetingId) => input.repos.getMeeting(meetingId))
    .filter((meeting): meeting is NonNullable<typeof meeting> => meeting !== null);

  if (meetings.length < 2) {
    throw new Error("create_kb requires at least two existing meetings");
  }

  const meetingIds = new Set(meetings.map((meeting) => meeting.id));
  const actions = input.repos.listActionItems().filter((action) => meetingIds.has(action.meeting_id));
  const calendars = input.repos.listCalendarDrafts().filter((calendar) => meetingIds.has(calendar.meeting_id));
  const owner = meetings.find((meeting) => meeting.organizer !== null)?.organizer ?? request.recipient;
  const dryRun = input.config?.feishuDryRun ?? true;
  const draft = runKnowledgeCuratorAgent({
    topicName: payload.topic_name,
    owner,
    meetings,
    actions,
    calendars,
    confidenceOrigin: payload.topic_match.score
  });
  const markdown = renderKnowledgeBaseMarkdown(draft);
  const wikiUrl = dryRun ? `mock://feishu/wiki/${draft.kb_id}` : null;
  const homepageUrl = dryRun ? `mock://feishu/wiki/${draft.kb_id}/00-home` : null;

  const existing = input.repos.getKnowledgeBase(draft.kb_id);
  const knowledgeBase =
    existing ??
    input.repos.createKnowledgeBase({
      id: draft.kb_id,
      name: draft.name,
      goal: draft.goal,
      description: draft.description,
      owner: draft.owner,
      status: draft.status,
      confidence_origin: draft.confidence_origin,
      wiki_url: wikiUrl,
      homepage_url: homepageUrl,
      related_keywords_json: JSON.stringify(draft.related_keywords),
      created_from_meetings_json: JSON.stringify(draft.created_from_meetings),
      auto_append_policy: "ask_every_time"
    });

  const update = KnowledgeUpdateSchema.parse({
    update_id: createId("kbu"),
    kb_id: knowledgeBase.id,
    update_type: "kb_created",
    summary: `创建主题知识库：${knowledgeBase.name}`,
    source_ids: payload.meeting_ids,
    before: null,
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

  for (const meeting of meetings) {
    input.repos.updateMeetingTopic({
      id: meeting.id,
      matched_kb_id: knowledgeBase.id,
      match_score: payload.topic_match.score,
      archive_status: "archived"
    });
  }

  input.repos.updateConfirmationRequest({
    id: request.id,
    status: "executed",
    executed_at: nowIso(),
    error: null
  });

  return {
    confirmation: input.repos.getConfirmationRequest(request.id) ?? request,
    knowledge_base: knowledgeBase,
    knowledge_update: knowledgeUpdate,
    draft,
    markdown,
    dry_run: dryRun
  };
}
