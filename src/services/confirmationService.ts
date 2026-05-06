import { ConfirmationRequestRow, Repositories } from "./store/repositories";
import { ConfirmationRequestType } from "../schemas";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dates";
import { createTask } from "../tools/larkTask";
import { createCalendarEvent } from "../tools/larkCalendar";
import { AppConfig } from "../config";
import { buildConfirmationCard } from "../agents/cardInteractionAgent";
import { createKnowledgeBaseWorkflow } from "../workflows/createKnowledgeBaseWorkflow";
import { appendMeetingToKnowledgeBaseWorkflow } from "../workflows/appendMeetingToKnowledgeBaseWorkflow";
import { ActionItemDraftSchema, CalendarEventDraftSchema } from "../schemas";
import { LlmClient } from "./llm/llmClient";
import { type LarkCliRunner } from "../tools/larkCli";
import { readPrompt } from "../utils/prompts";

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withCardPreview(input: {
  id: string;
  requestType: ConfirmationRequestType;
  targetId: string;
  recipient: string | null;
  status: "sent";
  originalPayload: unknown;
}): Record<string, unknown> {
  const payload = asObject(input.originalPayload);
  const originalPayload =
    Object.keys(payload).length > 0 ? payload : { value: input.originalPayload };
  const cardPreview = buildConfirmationCard({
    id: input.id,
    request_type: input.requestType,
    target_id: input.targetId,
    recipient: input.recipient,
    status: input.status,
    original_payload: originalPayload
  });

  return {
    ...originalPayload,
    card_preview: cardPreview
  };
}

function parseJsonArray(value: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function parseStringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return [];
    }

    try {
      return parseStringArrayValue(JSON.parse(trimmed) as unknown);
    } catch {
      return [trimmed];
    }
  }

  return [];
}

function editedDraftPatch(value: unknown): Record<string, unknown> {
  const payload = asObject(value);
  return {
    ...payload,
    ...asObject(payload.draft)
  };
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (value === null) {
    return {};
  }

  return asObject(JSON.parse(value) as unknown);
}

function stringFromValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberFromValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addMinutesIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function missingActionFields(input: { owner: string | null; dueDate: string | null }): string[] {
  const fields: string[] = [];
  if (!hasText(input.owner)) fields.push("owner");
  if (!hasText(input.dueDate)) fields.push("due_date");
  return fields;
}

function currentMeetingIdFromCreateKbPayload(payload: Record<string, unknown>): string | null {
  const direct =
    stringFromValue(payload.current_meeting_id) ??
    stringFromValue(payload.meeting_id) ??
    stringFromValue(payload.source_meeting_id);
  if (direct !== null) {
    return direct;
  }

  const meetingIds = [
    ...parseStringArrayValue(payload.candidate_meeting_ids),
    ...parseStringArrayValue(payload.meeting_ids)
  ];
  return meetingIds.at(-1) ?? null;
}

function createKbNameFromPayload(input: {
  payload: Record<string, unknown>;
  meetingTitle: string;
}): string {
  return (
    stringFromValue(input.payload.kb_name) ??
    stringFromValue(input.payload.topic_name) ??
    `${input.meetingTitle}知识库`
  );
}

function sourcePayloadFromOriginal(original: Record<string, unknown>): Record<string, unknown> {
  return {
    meeting_reference: original.meeting_reference,
    meeting_title: original.meeting_title,
    minutes_url: original.minutes_url,
    transcript_url: original.transcript_url,
    external_meeting_id: original.external_meeting_id
  };
}

function mergeEditedPayload(input: {
  existingJson: string | null;
  editedPayload?: unknown;
}): Record<string, unknown> {
  return {
    ...editedDraftPatch(parseJsonObject(input.existingJson)),
    ...editedDraftPatch(input.editedPayload)
  };
}

function ownerIdFromValue(value: unknown, depth = 0): string | null {
  if (depth > 8) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const ownerId = ownerIdFromValue(item, depth + 1);
      if (ownerId !== null) {
        return ownerId;
      }
    }
    return null;
  }

  const record = asObject(value);
  for (const key of ["open_id", "user_id", "id", "value"] as const) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const ownerId = ownerIdFromValue(record[key], depth + 1);
      if (ownerId !== null) {
        return ownerId;
      }
    }
  }

  return null;
}

function normalizeActionOwnerPatch(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(payload, "owner")) {
    return payload;
  }

  const owner = ownerIdFromValue(payload.owner);
  return owner === null ? payload : { ...payload, owner };
}

function hasText(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

function trimToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function usableOpenId(value: string | null | undefined): string | null {
  const text = trimToNull(value);
  return text?.startsWith("ou_") ? text : null;
}

function resolveActionOwner(input: {
  draftOwner: string | null;
  recipient: string | null;
  actorOpenId?: string | null;
}): {
  owner: string;
  fallbackApplied: boolean;
} {
  const explicitOwner = trimToNull(input.draftOwner);
  if (explicitOwner !== null) {
    return {
      owner: explicitOwner,
      fallbackApplied: false
    };
  }

  const fallbackOwner = usableOpenId(input.recipient) ?? usableOpenId(input.actorOpenId);
  if (fallbackOwner === null) {
    throw new Error(
      "Cannot create personal Feishu task: missing confirmation recipient open_id or card callback open_id"
    );
  }

  return {
    owner: fallbackOwner,
    fallbackApplied: true
  };
}

function appendPersonalTodoFallbackReason(suggestedReason: string): string {
  const note = "会议未识别明确负责人；本次确认按个人待办创建。";
  return suggestedReason.includes(note) ? suggestedReason : [suggestedReason, note].join("\n");
}

function removeKnownMissingFields(missingFields: string[], filledFields: string[]): string[] {
  const filled = new Set(filledFields);
  return missingFields.filter((field) => !filled.has(field));
}

function addKnownMissingField(missingFields: string[], field: string): string[] {
  return missingFields.includes(field) ? missingFields : [...missingFields, field];
}

function cleanActionMissingFields(draft: {
  title: string;
  owner: string | null;
  due_date: string | null;
  priority: string | null;
  missing_fields: string[];
}): string[] {
  const filledFields: string[] = [];
  if (hasText(draft.owner)) filledFields.push("owner");
  if (hasText(draft.due_date)) filledFields.push("due_date");
  if (hasText(draft.title)) filledFields.push("title");
  if (hasText(draft.priority)) filledFields.push("priority");
  return removeKnownMissingFields(draft.missing_fields, filledFields);
}

function cleanCalendarMissingFields(draft: {
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  participants: string[];
  location: string | null;
  agenda: string | null;
  missing_fields: string[];
}): string[] {
  const filledFields: string[] = [];
  if (hasText(draft.start_time)) filledFields.push("start_time");
  if (hasText(draft.end_time)) filledFields.push("end_time");
  if (draft.duration_minutes !== null) filledFields.push("duration_minutes");
  if (draft.participants.length > 0) filledFields.push("participants");
  if (hasText(draft.location)) filledFields.push("location");
  if (hasText(draft.agenda)) filledFields.push("agenda");
  return removeKnownMissingFields(draft.missing_fields, filledFields);
}

function actionChangedFields(input: {
  patch: Record<string, unknown>;
  original: {
    title: string;
    owner: string | null;
    due_date: string | null;
    priority: string | null;
  };
  draft: {
    title: string;
    owner: string | null;
    due_date: string | null;
    priority: string | null;
  };
}): string[] {
  const fields = ["owner", "title", "due_date", "priority"] as const;
  return fields.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(input.patch, field) &&
      input.draft[field] !== input.original[field]
  );
}

function appendActionSuggestedReason(suggestedReason: string, changedFields: string[]): string {
  if (changedFields.length === 0) {
    return suggestedReason;
  }

  const notes = [`用户确认时已修改字段：${changedFields.join(", ")}。`];
  if (changedFields.includes("owner")) {
    notes.push("原始会议证据中的负责人可能与最终确认负责人不同，以用户确认结果为准。");
  }

  return [suggestedReason, ...notes].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failRequest(input: {
  repos: Repositories;
  request: ConfirmationRequestRow;
  error: unknown;
}): ConfirmationRequestRow {
  const message = errorMessage(input.error);
  input.repos.updateConfirmationRequest({
    id: input.request.id,
    status: "failed",
    error: message
  });

  return (
    input.repos.getConfirmationRequest(input.request.id) ?? {
      ...input.request,
      status: "failed",
      error: message,
      updated_at: nowIso()
    }
  );
}

function cannotTransitionMessage(input: {
  action: string;
  request: ConfirmationRequestRow;
}): string {
  return `Cannot ${input.action} ${input.request.status} request: ${input.request.id}`;
}

function assertRequestCanTransition(input: { request: ConfirmationRequestRow; action: string }) {
  if (["confirmed", "executed", "failed", "rejected"].includes(input.request.status)) {
    throw new Error(cannotTransitionMessage(input));
  }
}

function assertRequestCanConfirm(input: {
  request: ConfirmationRequestRow;
  allowPreconfirmed?: boolean;
}): "already_executed" | "can_confirm" {
  const { request } = input;
  if (request.status === "executed") {
    return "already_executed";
  }
  if (request.status === "confirmed" && input.allowPreconfirmed === true) {
    return "can_confirm";
  }
  if (["confirmed", "failed", "rejected"].includes(request.status)) {
    throw new Error(cannotTransitionMessage({ action: "confirm", request }));
  }

  return "can_confirm";
}

export function createConfirmationRequest(input: {
  repos: Repositories;
  requestType: ConfirmationRequestType;
  targetId: string;
  recipient: string | null;
  originalPayload: unknown;
}): ConfirmationRequestRow {
  const id = createId("conf");
  const status = "sent" as const;
  const originalPayloadWithCardPreview = withCardPreview({
    id,
    requestType: input.requestType,
    targetId: input.targetId,
    recipient: input.recipient,
    status,
    originalPayload: input.originalPayload
  });

  return input.repos.createConfirmationRequest({
    id,
    request_type: input.requestType,
    target_id: input.targetId,
    recipient: input.recipient,
    card_message_id: null,
    status,
    original_payload_json: JSON.stringify(originalPayloadWithCardPreview),
    edited_payload_json: null,
    confirmed_at: null,
    executed_at: null,
    error: null
  });
}

export function snoozeConfirmation(input: {
  repos: Repositories;
  id: string;
  minutes?: number;
  reminder?: unknown;
}): {
  confirmation: ConfirmationRequestRow;
  snooze: {
    snoozed_at: string;
    snooze_until: string;
    minutes: number;
    reminder: unknown | null;
  };
} {
  const request = input.repos.getConfirmationRequest(input.id);
  if (!request) {
    throw new Error(`Confirmation request not found: ${input.id}`);
  }
  assertRequestCanTransition({ request, action: "snooze" });

  const minutes = input.minutes ?? 30;
  const snoozedAt = nowIso();
  const snooze = {
    snoozed_at: snoozedAt,
    snooze_until: addMinutesIso(minutes),
    minutes,
    reminder: input.reminder ?? null
  };
  const editedPayload = {
    ...parseJsonObject(request.edited_payload_json),
    card_action: "remind_later",
    snooze
  };

  input.repos.updateConfirmationRequest({
    id: request.id,
    status: "snoozed",
    edited_payload_json: JSON.stringify(editedPayload),
    error: null
  });

  return {
    confirmation: input.repos.getConfirmationRequest(request.id) ?? {
      ...request,
      status: "snoozed",
      edited_payload_json: JSON.stringify(editedPayload),
      error: null,
      updated_at: snoozedAt
    },
    snooze
  };
}

export async function convertCalendarConfirmationToActionConfirmation(input: {
  repos: Repositories;
  id: string;
  llm: LlmClient;
}): Promise<{
  source_confirmation: ConfirmationRequestRow;
  action_item_id: string;
  confirmation: ConfirmationRequestRow;
}> {
  const request = input.repos.getConfirmationRequest(input.id);
  if (!request) {
    throw new Error(`Confirmation request not found: ${input.id}`);
  }
  if (request.request_type !== "calendar") {
    throw new Error(`convert_to_task requires a calendar confirmation: ${input.id}`);
  }
  assertRequestCanTransition({ request, action: "convert_to_task" });

  const calendar = input.repos.getCalendarDraft(request.target_id);
  if (!calendar) {
    throw new Error(`Calendar draft not found: ${request.target_id}`);
  }

  const originalPayload = parseJsonObject(request.original_payload_json);
  const participants = parseStringArrayValue(calendar.participants_json);
  const calendarPrompt = readPrompt("calendar.md");
  const today = new Date().toISOString().split("T")[0];
  const llmOutput = await input.llm.generateJson<{
    title: string;
    description: string | null;
    owner: string | null;
    collaborators: string[];
    due_date: string | null;
    priority: "P0" | "P1" | "P2" | null;
    suggested_reason: string;
  }>({
    schemaName: "CalendarToActionDraft",
    systemPrompt: calendarPrompt,
    userPrompt: [
      `今天日期：${today}`,
      `日程标题：${calendar.title}`,
      `日程时间：${calendar.start_time ?? "未知"}`,
      `参与者：${participants.join("、") || "未知"}`,
      `议程：${calendar.agenda ?? "无"}`,
      `来源原文：${calendar.evidence}`,
      "",
      "用户已选择把这个日程草案转换为一个待办任务。请按照“第二部分：日程转待办”的规则，生成 ActionItemDraft JSON。"
    ].join("\n")
  });
  const draft = ActionItemDraftSchema.parse({
    title: llmOutput.title,
    description: llmOutput.description,
    owner: llmOutput.owner,
    collaborators: llmOutput.collaborators ?? [],
    due_date: llmOutput.due_date,
    priority: llmOutput.priority,
    evidence: calendar.evidence,
    confidence: calendar.confidence,
    suggested_reason: llmOutput.suggested_reason,
    missing_fields: missingActionFields({
      owner: llmOutput.owner,
      dueDate: llmOutput.due_date
    })
  });
  const action = input.repos.createActionItem({
    id: createId("act"),
    meeting_id: calendar.meeting_id,
    kb_id: calendar.kb_id,
    title: draft.title,
    description: draft.description,
    owner: draft.owner,
    collaborators_json: JSON.stringify(draft.collaborators),
    due_date: draft.due_date,
    priority: draft.priority,
    evidence: draft.evidence,
    confidence: draft.confidence,
    suggested_reason: draft.suggested_reason,
    missing_fields_json: JSON.stringify(draft.missing_fields),
    confirmation_status: "sent",
    feishu_task_guid: null,
    task_url: null,
    rejection_reason: null
  });
  const confirmation = createConfirmationRequest({
    repos: input.repos,
    requestType: "action",
    targetId: action.id,
    recipient: draft.owner ?? request.recipient,
    originalPayload: {
      draft,
      source_calendar_confirmation_id: request.id,
      calendar_draft_id: calendar.id,
      meeting_id: calendar.meeting_id,
      ...sourcePayloadFromOriginal(originalPayload)
    }
  });

  input.repos.updateCalendarDraftRejection(calendar.id);
  input.repos.updateConfirmationRequest({
    id: request.id,
    status: "rejected",
    error: "converted_to_task"
  });

  return {
    source_confirmation: input.repos.getConfirmationRequest(request.id) ?? {
      ...request,
      status: "rejected",
      error: "converted_to_task"
    },
    action_item_id: action.id,
    confirmation
  };
}

export function appendCurrentOnlyConfirmation(input: { repos: Repositories; id: string }): {
  source_confirmation: ConfirmationRequestRow;
  knowledge_base_id: string;
  meeting_id: string;
  confirmation: ConfirmationRequestRow;
} {
  const request = input.repos.getConfirmationRequest(input.id);
  if (!request) {
    throw new Error(`Confirmation request not found: ${input.id}`);
  }
  if (request.request_type !== "create_kb") {
    throw new Error(`append_current_only requires a create_kb confirmation: ${input.id}`);
  }
  assertRequestCanTransition({ request, action: "append_current_only" });

  const payload = parseJsonObject(request.original_payload_json);
  const meetingId = currentMeetingIdFromCreateKbPayload(payload);
  if (meetingId === null) {
    throw new Error(`Cannot append current meeting without meeting_id: ${input.id}`);
  }

  const meeting = input.repos.getMeeting(meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  const existingCandidate = request.target_id.startsWith("kb_")
    ? input.repos.getKnowledgeBase(request.target_id)
    : null;
  const knowledgeBase =
    existingCandidate ??
    input.repos.createKnowledgeBase({
      id: request.target_id.startsWith("kb_") ? request.target_id : createId("kb"),
      name: createKbNameFromPayload({ payload, meetingTitle: meeting.title }),
      goal: stringFromValue(payload.suggested_goal) ?? stringFromValue(payload.goal),
      description: stringFromValue(payload.reason),
      owner: request.recipient,
      status: "candidate",
      confidence_origin: numberFromValue(payload.score) ?? 0,
      wiki_url: null,
      homepage_url: null,
      related_keywords_json: JSON.stringify(parseStringArrayValue(payload.topic_keywords)),
      created_from_meetings_json: JSON.stringify([meeting.id]),
      auto_append_policy: "manual_confirm"
    });
  const appendConfirmation = createConfirmationRequest({
    repos: input.repos,
    requestType: "append_meeting",
    targetId: meeting.id,
    recipient: request.recipient ?? meeting.organizer,
    originalPayload: {
      kb_id: knowledgeBase.id,
      kb_name: knowledgeBase.name,
      meeting_id: meeting.id,
      meeting_title: meeting.title,
      meeting_reference:
        stringFromValue(payload.meeting_reference) ??
        stringFromValue(payload.current_meeting_reference) ??
        meeting.title,
      minutes_url: meeting.minutes_url,
      transcript_url: meeting.transcript_url,
      external_meeting_id: meeting.external_meeting_id,
      meeting_summary:
        stringFromValue(payload.meeting_summary) ?? meeting.summary ?? "当前会议待追加。",
      key_decisions: parseStringArrayValue(payload.key_decisions).map((decision) => ({
        decision,
        evidence: "来自创建知识库候选卡。"
      })),
      risks: parseStringArrayValue(payload.risks).map((risk) => ({
        risk,
        evidence: "来自创建知识库候选卡。"
      })),
      topic_keywords: parseStringArrayValue(payload.topic_keywords),
      match_reasons: parseStringArrayValue(payload.match_reasons),
      score: numberFromValue(payload.score) ?? 0,
      reason: "用户选择只归档当前会议，转入追加会议确认流程。"
    }
  });

  input.repos.updateConfirmationRequest({
    id: request.id,
    status: "rejected",
    error: "append_current_only"
  });

  return {
    source_confirmation: input.repos.getConfirmationRequest(request.id) ?? {
      ...request,
      status: "rejected",
      error: "append_current_only"
    },
    knowledge_base_id: knowledgeBase.id,
    meeting_id: meeting.id,
    confirmation: appendConfirmation
  };
}

export function completeActionOwner(input: {
  repos: Repositories;
  id: string;
  editedPayload?: unknown;
}): {
  confirmation: ConfirmationRequestRow;
  owner: string | null;
  editedPayload: Record<string, unknown>;
} {
  const request = input.repos.getConfirmationRequest(input.id);
  if (!request) {
    throw new Error(`Confirmation request not found: ${input.id}`);
  }
  if (request.request_type !== "action") {
    throw new Error(`Owner completion is only supported for action requests: ${input.id}`);
  }
  if (request.status === "executed") {
    return {
      confirmation: request,
      owner: null,
      editedPayload: {}
    };
  }
  if (request.status === "rejected") {
    throw new Error(`Cannot complete owner for rejected request: ${input.id}`);
  }

  const editedPayload = normalizeActionOwnerPatch(
    mergeEditedPayload({
      existingJson: request.edited_payload_json,
      editedPayload: input.editedPayload
    })
  );
  const owner = ownerIdFromValue(editedPayload.owner) ?? "";

  input.repos.updateConfirmationRequest({
    id: request.id,
    status: "edited",
    edited_payload_json: JSON.stringify(editedPayload),
    error: null
  });

  return {
    confirmation: input.repos.getConfirmationRequest(request.id) ?? {
      ...request,
      status: "edited",
      edited_payload_json: JSON.stringify(editedPayload),
      error: null,
      updated_at: nowIso()
    },
    owner: owner.length > 0 ? owner : null,
    editedPayload
  };
}

export async function confirmRequest(input: {
  repos: Repositories;
  config?: AppConfig;
  id: string;
  editedPayload?: unknown;
  actorOpenId?: string | null;
  allowPreconfirmed?: boolean;
  llm?: LlmClient;
  runner?: LarkCliRunner;
}): Promise<{
  confirmation: ConfirmationRequestRow;
  result: unknown;
}> {
  const request = input.repos.getConfirmationRequest(input.id);
  if (!request) {
    throw new Error(`Confirmation request not found: ${input.id}`);
  }
  if (
    assertRequestCanConfirm({
      request,
      allowPreconfirmed: input.allowPreconfirmed
    }) === "already_executed"
  ) {
    return {
      confirmation: request,
      result: { already_executed: true }
    };
  }

  const confirmedAt = nowIso();
  input.repos.updateConfirmationRequest({
    id: request.id,
    status: "confirmed",
    edited_payload_json:
      input.editedPayload === undefined ? null : JSON.stringify(input.editedPayload),
    confirmed_at: confirmedAt,
    error: null
  });

  if (request.request_type === "action") {
    try {
      const action = input.repos.getActionItem(request.target_id);
      if (!action) {
        throw new Error(`Action item not found: ${request.target_id}`);
      }
      const patch = mergeEditedPayload({
        existingJson: request.edited_payload_json,
        editedPayload: input.editedPayload
      });
      const draft = ActionItemDraftSchema.parse({
        title: action.title,
        description: action.description,
        owner: action.owner,
        collaborators: parseJsonArray(action.collaborators_json),
        due_date: action.due_date,
        priority: action.priority,
        evidence: action.evidence,
        confidence: action.confidence,
        suggested_reason: action.suggested_reason,
        missing_fields: parseJsonArray(action.missing_fields_json),
        ...patch
      });
      const ownerResolution = resolveActionOwner({
        draftOwner: draft.owner,
        recipient: request.recipient,
        actorOpenId: input.actorOpenId
      });
      const effectiveDraft = {
        ...draft,
        owner: ownerResolution.owner,
        suggested_reason: ownerResolution.fallbackApplied
          ? appendPersonalTodoFallbackReason(draft.suggested_reason)
          : draft.suggested_reason
      };
      const changedFields = actionChangedFields({
        patch,
        original: action,
        draft: effectiveDraft
      });
      const missingFields = cleanActionMissingFields(effectiveDraft);
      input.repos.updateActionItemDraft({
        id: action.id,
        title: effectiveDraft.title,
        description: effectiveDraft.description,
        owner: effectiveDraft.owner,
        collaborators_json: JSON.stringify(effectiveDraft.collaborators),
        due_date: effectiveDraft.due_date,
        priority: effectiveDraft.priority,
        evidence: effectiveDraft.evidence,
        confidence: effectiveDraft.confidence,
        suggested_reason: appendActionSuggestedReason(
          effectiveDraft.suggested_reason,
          changedFields
        ),
        missing_fields_json: JSON.stringify(missingFields)
      });

      const updatedAction = input.repos.getActionItem(action.id) ?? action;
      const result = await createTask({
        repos: input.repos,
        config: input.config,
        draft: updatedAction,
        runner: input.runner
      });
      input.repos.updateActionItemAfterCreate({
        id: action.id,
        confirmation_status: "created",
        feishu_task_guid: result.feishu_task_guid,
        task_url: result.task_url
      });
      input.repos.updateConfirmationRequest({
        id: request.id,
        status: "executed",
        executed_at: nowIso(),
        error: null
      });

      return {
        confirmation: input.repos.getConfirmationRequest(request.id) ?? request,
        result
      };
    } catch (error) {
      return {
        confirmation: failRequest({ repos: input.repos, request, error }),
        result: { failed: true, error: errorMessage(error) }
      };
    }
  }

  if (request.request_type === "calendar") {
    try {
      const calendarDraft = input.repos.getCalendarDraft(request.target_id);
      if (!calendarDraft) {
        throw new Error(`Calendar draft not found: ${request.target_id}`);
      }
      const patch = mergeEditedPayload({
        existingJson: request.edited_payload_json,
        editedPayload: input.editedPayload
      });
      const draft = CalendarEventDraftSchema.parse({
        title: calendarDraft.title,
        start_time: calendarDraft.start_time,
        end_time: calendarDraft.end_time,
        duration_minutes: calendarDraft.duration_minutes,
        participants: parseJsonArray(calendarDraft.participants_json),
        agenda: calendarDraft.agenda,
        location: calendarDraft.location,
        evidence: calendarDraft.evidence,
        confidence: calendarDraft.confidence,
        missing_fields: parseJsonArray(calendarDraft.missing_fields_json),
        ...patch
      });
      input.repos.updateCalendarDraft({
        id: calendarDraft.id,
        title: draft.title,
        start_time: draft.start_time,
        end_time: draft.end_time,
        duration_minutes: draft.duration_minutes,
        participants_json: JSON.stringify(draft.participants),
        agenda: draft.agenda,
        location: draft.location,
        evidence: draft.evidence,
        confidence: draft.confidence,
        missing_fields_json: JSON.stringify(cleanCalendarMissingFields(draft))
      });
      const updatedDraft = input.repos.getCalendarDraft(calendarDraft.id) ?? calendarDraft;
      const result = await createCalendarEvent({
        repos: input.repos,
        config: input.config,
        draft: updatedDraft,
        runner: input.runner
      });
      input.repos.updateCalendarDraftAfterCreate({
        id: calendarDraft.id,
        confirmation_status: "created",
        calendar_event_id: result.calendar_event_id,
        event_url: result.event_url
      });
      input.repos.updateConfirmationRequest({
        id: request.id,
        status: "executed",
        executed_at: nowIso(),
        error: null
      });

      return {
        confirmation: input.repos.getConfirmationRequest(request.id) ?? request,
        result
      };
    } catch (error) {
      return {
        confirmation: failRequest({ repos: input.repos, request, error }),
        result: { failed: true, error: errorMessage(error) }
      };
    }
  }

  if (request.request_type === "create_kb") {
    try {
      const result = await createKnowledgeBaseWorkflow({
        repos: input.repos,
        config: input.config,
        confirmationId: request.id,
        llm: input.llm,
        runner: input.runner
      });
      const editedPayload = {
        ...parseJsonObject(result.confirmation.edited_payload_json ?? request.edited_payload_json),
        result_links: {
          knowledge_base_id: result.knowledge_base.id,
          wiki_url: result.knowledge_base.wiki_url,
          homepage_url: result.knowledge_base.homepage_url
        }
      };
      input.repos.updateConfirmationRequest({
        id: request.id,
        status: result.confirmation.status,
        edited_payload_json: JSON.stringify(editedPayload),
        executed_at: result.confirmation.executed_at,
        error: result.confirmation.error
      });

      return {
        confirmation: input.repos.getConfirmationRequest(request.id) ?? result.confirmation,
        result
      };
    } catch (error) {
      return {
        confirmation: failRequest({ repos: input.repos, request, error }),
        result: { failed: true, error: errorMessage(error) }
      };
    }
  }

  if (request.request_type === "append_meeting") {
    try {
      const result = await appendMeetingToKnowledgeBaseWorkflow({
        repos: input.repos,
        config: input.config,
        confirmationId: request.id,
        runner: input.runner
      });

      return {
        confirmation: result.confirmation,
        result
      };
    } catch (error) {
      return {
        confirmation: failRequest({ repos: input.repos, request, error }),
        result: { failed: true, error: errorMessage(error) }
      };
    }
  }

  throw new Error(`Request type is not executable in current phase: ${request.request_type}`);
}

export function rejectRequest(input: {
  repos: Repositories;
  id: string;
  reason?: string | null;
}): ConfirmationRequestRow {
  const request = input.repos.getConfirmationRequest(input.id);
  if (!request) {
    throw new Error(`Confirmation request not found: ${input.id}`);
  }
  assertRequestCanTransition({ request, action: "reject" });

  if (request.request_type === "action") {
    input.repos.updateActionItemRejection({
      id: request.target_id,
      rejection_reason: input.reason ?? null
    });
  } else if (request.request_type === "calendar") {
    input.repos.updateCalendarDraftRejection(request.target_id);
  } else if (request.request_type === "append_meeting") {
    const original = JSON.parse(request.original_payload_json) as unknown;
    const payload = asObject(original);
    const kbId = typeof payload.kb_id === "string" ? payload.kb_id : null;
    const meeting = input.repos.getMeeting(request.target_id);
    input.repos.updateMeetingTopic({
      id: request.target_id,
      matched_kb_id: kbId,
      match_score: meeting?.match_score ?? 0,
      archive_status: "rejected"
    });
  }

  input.repos.updateConfirmationRequest({
    id: request.id,
    status: "rejected",
    error: input.reason ?? null
  });

  return (
    input.repos.getConfirmationRequest(request.id) ?? {
      ...request,
      status: "rejected",
      error: input.reason ?? null
    }
  );
}
