import { ConfirmationRequestRow, Repositories } from "./store/repositories";
import { ConfirmationRequestType } from "../schemas";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dates";
import { createTask } from "../tools/larkTask";
import { createCalendarEvent } from "../tools/larkCalendar";
import { AppConfig } from "../config";
import { createKnowledgeBaseWorkflow } from "../workflows/createKnowledgeBaseWorkflow";

export function createConfirmationRequest(input: {
  repos: Repositories;
  requestType: ConfirmationRequestType;
  targetId: string;
  recipient: string | null;
  originalPayload: unknown;
}): ConfirmationRequestRow {
  return input.repos.createConfirmationRequest({
    id: createId("conf"),
    request_type: input.requestType,
    target_id: input.targetId,
    recipient: input.recipient,
    card_message_id: null,
    status: "sent",
    original_payload_json: JSON.stringify(input.originalPayload),
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
    edited_payload_json: input.editedPayload === undefined ? null : JSON.stringify(input.editedPayload),
    confirmed_at: confirmedAt,
    error: null
  });

  if (request.request_type === "action") {
    const action = input.repos.getActionItem(request.target_id);
    if (!action) {
      throw new Error(`Action item not found: ${request.target_id}`);
    }
    const result = await createTask({
      repos: input.repos,
      config: input.config,
      draft: action
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
  }

  if (request.request_type === "calendar") {
    const calendarDraft = input.repos.getCalendarDraft(request.target_id);
    if (!calendarDraft) {
      throw new Error(`Calendar draft not found: ${request.target_id}`);
    }
    const result = await createCalendarEvent({
      repos: input.repos,
      config: input.config,
      draft: calendarDraft
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
  }

  if (request.request_type === "create_kb") {
    const result = await createKnowledgeBaseWorkflow({
      repos: input.repos,
      config: input.config,
      confirmationId: request.id
    });

    return {
      confirmation: result.confirmation,
      result
    };
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
