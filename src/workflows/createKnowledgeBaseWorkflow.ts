import { z } from "zod";
import {
  renderKnowledgeBaseMarkdown,
  runKnowledgeCuratorAgent
} from "../agents/knowledgeCuratorAgent";
import { AppConfig, loadConfig } from "../config";
import { KnowledgeBaseDraft, KnowledgeUpdateSchema, TopicMatchResultSchema } from "../schemas";
import { createLlmClient } from "../services/llm/createLlmClient";
import { LlmClient } from "../services/llm/llmClient";
import {
  ConfirmationRequestRow,
  KnowledgeBaseRow,
  KnowledgeUpdateRow,
  Repositories
} from "../services/store/repositories";
import { createDoc } from "../tools/larkDoc";
import { type LarkCliRunner } from "../tools/larkCli";
import { createWikiSpace } from "../tools/larkWiki";
import { nowIso } from "../utils/dates";
import { createId } from "../utils/id";

const CreateKnowledgeBasePayloadSchema = z
  .object({
    topic_name: z.string().min(1),
    suggested_goal: z.string().min(1).optional(),
    candidate_meeting_ids: z.array(z.string().min(1)).min(1).optional(),
    match_reasons: z.array(z.string()).optional(),
    score: z.number().min(0).max(1).optional(),
    default_structure: z.array(z.string()).optional(),
    curation_guidance: z.array(z.string()).optional(),
    topic_match: TopicMatchResultSchema,
    meeting_ids: z.array(z.string().min(1)).min(1).optional(),
    reason: z.string().min(1).optional()
  })
  .transform((payload) => ({
    ...payload,
    meeting_ids:
      payload.meeting_ids ??
      payload.candidate_meeting_ids ??
      payload.topic_match.candidate_meeting_ids,
    match_reasons: payload.match_reasons ?? payload.topic_match.match_reasons,
    score: payload.score ?? payload.topic_match.score
  }))
  .refine((payload) => payload.meeting_ids.length >= 1, {
    message: "create_kb requires at least one candidate meeting",
    path: ["meeting_ids"]
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parsePayload(request: ConfirmationRequestRow): CreateKnowledgeBasePayload {
  const original = JSON.parse(request.original_payload_json) as unknown;
  const edited = request.edited_payload_json
    ? (JSON.parse(request.edited_payload_json) as unknown)
    : {};
  return CreateKnowledgeBasePayloadSchema.parse({
    ...asObject(original),
    ...asObject(edited)
  });
}

export async function createKnowledgeBaseWorkflow(input: {
  repos: Repositories;
  config?: AppConfig;
  confirmationId: string;
  llm?: LlmClient;
  runner?: LarkCliRunner;
}): Promise<CreateKnowledgeBaseWorkflowResult> {
  const config = input.config ?? loadConfig();
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

  if (meetings.length < 1) {
    throw new Error("create_kb requires at least one existing meeting");
  }

  const meetingIds = new Set(meetings.map((meeting) => meeting.id));
  const actions = input.repos
    .listActionItems()
    .filter((action) => meetingIds.has(action.meeting_id));
  const calendars = input.repos
    .listCalendarDrafts()
    .filter((calendar) => meetingIds.has(calendar.meeting_id));
  const owner =
    request.recipient ?? meetings.find((meeting) => meeting.organizer !== null)?.organizer ?? null;
  const dryRun = config.feishuKnowledgeWriteDryRun ?? config.feishuDryRun ?? true;
  const llm = input.llm ?? createLlmClient(config);

  const draft = await runKnowledgeCuratorAgent({
    topicName: payload.topic_name,
    owner,
    meetings,
    actions,
    calendars,
    confidenceOrigin: payload.topic_match.score,
    llm
  });
  const markdown = renderKnowledgeBaseMarkdown(draft);
  let wikiUrl = `mock://feishu/wiki/${draft.kb_id}`;
  let homepageUrl = `mock://feishu/wiki/${draft.kb_id}/00-home`;

  if (!dryRun) {
    const wikiSpace = await createWikiSpace({
      repos: input.repos,
      config,
      name: payload.topic_name,
      description: draft.description ?? "",
      runner: input.runner
    });
    wikiUrl = wikiSpace.wiki_space_url;
    homepageUrl = wikiSpace.homepage_url;

    for (const page of draft.pages.slice(1)) {
      await createDoc({
        repos: input.repos,
        config,
        title: page.title,
        content: page.markdown,
        spaceId: wikiSpace.wiki_space_id,
        runner: input.runner
      });
    }
  }

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
