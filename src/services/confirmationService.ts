import { ConfirmationRequestRow, Repositories } from "./store/repositories";
import { ConfirmationRequestType } from "../schemas";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dates";
import { createTask } from "../tools/larkTask";
import { createCalendarEvent } from "../tools/larkCalendar";
import { AppConfig } from "../config";
import { buildConfirmationCard } from "../agents/cardInteractionAgent";
import { createKnowledgeBaseWorkflow } from "../workflows/createKnowledgeBaseWorkflow";
import { ActionItemDraftSchema, CalendarEventDraftSchema } from "../schemas";

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

function editedDraftPatch(value: unknown): Record<string, unknown> {
  const payload = asObject(value);
  return {
    ...payload,
    ...asObject(payload.draft)
  };
}

function hasText(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

function removeKnownMissingFields(missingFields: string[], filledFields: string[]): string[] {
  const filled = new Set(filledFields);
  return missingFields.filter((field) => !filled.has(field));
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
    notes.push(
      "原始会议证据中的负责人可能与最终确认负责人不同，以用户确认结果为准。"
    );
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

  return input.repos.getConfirmationRequest(input.request.id) ?? {
    ...input.request,
    status: "failed",
    error: message,
    updated_at: nowIso()
  };
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

export async function confirmRequest(input: {
  repos: Repositories;
  config?: AppConfig;
  id: string;
  editedPayload?: unknown;
}): Promise<{
  confirmation: ConfirmationRequestRow;
  result: unknown;
}> {
  const request = input.repos.getConfirmationRequest(input.id);
  if (!request) {
    throw new Error(`Confirmation request not found: ${input.id}`);
  }
  if (request.status === "executed") {
    return {
      confirmation: request,
      result: { already_executed: true }
    };
  }
  if (request.status === "rejected") {
    throw new Error(`Cannot confirm rejected request: ${input.id}`);
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
      const patch = editedDraftPatch(input.editedPayload);
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
      const changedFields = actionChangedFields({
        patch,
        original: action,
        draft
      });
      input.repos.updateActionItemDraft({
        id: action.id,
        title: draft.title,
        description: draft.description,
        owner: draft.owner,
        collaborators_json: JSON.stringify(draft.collaborators),
        due_date: draft.due_date,
        priority: draft.priority,
        evidence: draft.evidence,
        confidence: draft.confidence,
        suggested_reason: appendActionSuggestedReason(draft.suggested_reason, changedFields),
        missing_fields_json: JSON.stringify(cleanActionMissingFields(draft))
      });
      const updatedAction = input.repos.getActionItem(action.id) ?? action;
      const result = await createTask({
        repos: input.repos,
        config: input.config,
        draft: updatedAction
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
      const patch = editedDraftPatch(input.editedPayload);
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
        draft: updatedDraft
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
        confirmationId: request.id
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

  if (request.request_type === "action") {
    input.repos.updateActionItemRejection({
      id: request.target_id,
      rejection_reason: input.reason ?? null
    });
  } else if (request.request_type === "calendar") {
    input.repos.updateCalendarDraftRejection(request.target_id);
  }

  input.repos.updateConfirmationRequest({
    id: request.id,
    status: "rejected",
    error: input.reason ?? null
  });

  return input.repos.getConfirmationRequest(request.id) ?? {
    ...request,
    status: "rejected",
    error: input.reason ?? null
  };
}
