import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { AppConfig } from "./config";
import { ManualMeetingInputSchema, ProcessMeetingTextInputSchema } from "./schemas";
import { buildConfirmationCardFromRequest } from "./agents/cardInteractionAgent";
import { runMeetingExtractionAgent } from "./agents/meetingExtractionAgent";
import { confirmRequest, rejectRequest } from "./services/confirmationService";
import { LlmClient } from "./services/llm/llmClient";
import { ConfirmationRequestRow, MeetingRow, Repositories } from "./services/store/repositories";
import { buildFeishuInteractiveCard, sendCard, syncConfirmationCardStatus } from "./tools/larkIm";
import { type LarkCliRunner } from "./tools/larkCli";
import { fetchTranscript } from "./tools/larkVc";
import { nowIso } from "./utils/dates";
import { verifyLarkCardActionSignature, verifyLarkWebhookSignature } from "./utils/larkSignature";
import {
  processMeetingTextToConfirmationsWorkflow,
  processMeetingWorkflow
} from "./workflows/processMeetingWorkflow";

const LlmSmokeTestInputSchema = z.object({
  text: z.string().min(1)
});

const SendCardBodySchema = z
  .object({
    recipient: z.string().trim().min(1).optional(),
    chat_id: z.string().trim().min(1).optional(),
    identity: z.enum(["bot", "user"]).optional()
  })
  .refine((body) => !(body.recipient && body.chat_id), {
    message: "Provide either recipient or chat_id, not both"
  });

const FeishuRecordingReadyEventType = "vc.meeting.recording_ready_v1";
const TranscriptPendingText = "【transcript pending - to be fetched via lark-cli vc +notes】";
const CardActionPendingMessage = "此操作暂未实现，将在 PR-2 中完成";
const CardActionAcceptedMessage = "已收到请求，正在添加到飞书…";
const TranscriptFetchTimeoutMs = 3000;

const FeishuRecordingReadyEventSchema = z
  .object({
    meeting_id: z.string().trim().min(1).optional().nullable(),
    topic: z.string().trim().optional().nullable(),
    minute_token: z.string().trim().optional().nullable(),
    host_user_id: z
      .object({
        open_id: z.string().trim().optional().nullable()
      })
      .optional()
      .nullable(),
    operator_id: z
      .object({
        open_id: z.string().trim().optional().nullable()
      })
      .optional()
      .nullable()
  })
  .passthrough();

type FeishuEventWebhookPayload = {
  challenge?: unknown;
  event_type?: unknown;
  header?: {
    event_type?: unknown;
  };
  event?: unknown;
};

type FastifyRequestWithRawBody = FastifyRequest & { rawBody?: string };

function configureJsonBodyParser(app: FastifyInstance) {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    (request as FastifyRequestWithRawBody).rawBody = rawBody;

    try {
      done(null, rawBody.length > 0 ? (JSON.parse(rawBody) as unknown) : {});
    } catch (error) {
      done(error as Error);
    }
  });
}

function getRawBody(request: FastifyRequest): string {
  return (request as FastifyRequestWithRawBody).rawBody ?? JSON.stringify(request.body ?? {});
}

function getHeaderString(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return typeof value === "string" ? value : null;
}

function isLarkSignatureValid(input: {
  request: FastifyRequest;
  body: string;
  verificationToken: string | null;
}): boolean {
  if (input.verificationToken === null) {
    return true;
  }

  const timestamp = getHeaderString(input.request, "x-lark-request-timestamp");
  const nonce = getHeaderString(input.request, "x-lark-request-nonce");
  const signature = getHeaderString(input.request, "x-lark-signature");

  if (timestamp === null || nonce === null || signature === null) {
    return false;
  }

  return verifyLarkWebhookSignature({
    timestamp,
    nonce,
    body: input.body,
    verificationToken: input.verificationToken,
    signature
  });
}

function isLarkCardActionSignatureValid(input: {
  request: FastifyRequest;
  rawBody: string;
  body: unknown;
  verificationToken: string | null;
}): boolean {
  if (input.verificationToken === null) {
    return true;
  }

  const timestamp = getHeaderString(input.request, "x-lark-request-timestamp");
  const nonce = getHeaderString(input.request, "x-lark-request-nonce");
  const signature = getHeaderString(input.request, "x-lark-signature");

  if (timestamp === null || nonce === null || signature === null) {
    return false;
  }

  if (
    verifyLarkWebhookSignature({
      timestamp,
      nonce,
      body: input.rawBody,
      verificationToken: input.verificationToken,
      signature
    })
  ) {
    return true;
  }

  return verifyLarkCardActionSignature({
    timestamp,
    nonce,
    body: input.body,
    verificationToken: input.verificationToken,
    signature
  });
}

function getLarkSignatureDiagnostics(request: FastifyRequest): Record<string, unknown> {
  const timestamp = getHeaderString(request, "x-lark-request-timestamp");
  const nonce = getHeaderString(request, "x-lark-request-nonce");
  const signature = getHeaderString(request, "x-lark-signature");

  return {
    has_timestamp: timestamp !== null,
    has_nonce: nonce !== null,
    has_signature: signature !== null,
    signature_length: signature?.length ?? 0
  };
}

function getFeishuEventType(payload: FeishuEventWebhookPayload): string | null {
  if (typeof payload.event_type === "string") {
    return payload.event_type;
  }

  return typeof payload.header?.event_type === "string" ? payload.header.event_type : null;
}

type ToastType = "info" | "success" | "error";

function toast(type: ToastType, content: string) {
  return {
    toast: {
      type,
      content
    }
  };
}

function cardCallbackResponse(input: {
  type: ToastType;
  content: string;
  confirmation: ConfirmationRequestRow;
}) {
  return {
    ...toast(input.type, input.content),
    card: buildFeishuInteractiveCard(buildConfirmationCardFromRequest(input.confirmation))
  };
}

const CONFIRM_CARD_ACTION_KEYS = new Set([
  "confirm",
  "confirm_with_edits",
  "create_kb",
  "edit_and_create",
  "complete_owner"
]);
const REJECT_CARD_ACTION_KEYS = new Set(["reject", "not_mine", "never_remind_topic"]);
const PREVIEW_STUB_CARD_ACTIONS = {
  remind_later: "remind_later",
  convert_to_task: "convert_to_task",
  append_current_only: "append_current_only"
} as const;
const PERSONAL_KNOWLEDGE_REQUEST_TYPES = new Set<ConfirmationRequestRow["request_type"]>([
  "create_kb",
  "append_meeting"
]);
const PROCESSED_CONFIRMATION_STATUSES = new Set(["executed", "rejected", "failed"]);
const IN_FLIGHT_CONFIRMATION_STATUSES = new Set(["confirmed"]);
const INTERNAL_CARD_VALUE_KEYS = new Set([
  "confirmation_id",
  "request_id",
  "action",
  "action_key",
  "key",
  "endpoint",
  "payload_template"
]);

function briefError(error: unknown): string {
  if (error instanceof ZodError) {
    return `schema validation failed: ${error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "result"} ${issue.message}`)
      .join("; ")}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (record === null) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function recordAtPath(value: unknown, path: string[]): Record<string, unknown> | null {
  return asRecord(valueAtPath(value, path));
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

function firstRecord(values: Array<Record<string, unknown> | null>): Record<string, unknown> {
  return values.find((value): value is Record<string, unknown> => value !== null) ?? {};
}

function isTemplatePlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("$");
}

function valueFromActionPayload(
  actionValue: Record<string, unknown>,
  key: string
): unknown | undefined {
  if (Object.prototype.hasOwnProperty.call(actionValue, key)) {
    const direct = actionValue[key];
    return isTemplatePlaceholder(direct) ? undefined : direct;
  }

  const payload = asRecord(actionValue.payload);
  if (payload && Object.prototype.hasOwnProperty.call(payload, key)) {
    const direct = payload[key];
    return isTemplatePlaceholder(direct) ? undefined : direct;
  }

  const template = asRecord(actionValue.payload_template);
  if (template && Object.prototype.hasOwnProperty.call(template, key)) {
    const direct = template[key];
    return isTemplatePlaceholder(direct) ? undefined : direct;
  }

  return undefined;
}

function normalizeFormValue(value: unknown): unknown {
  if (isTemplatePlaceholder(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeFormValue).filter((item) => item !== undefined);
  }

  const record = asRecord(value);
  if (record !== null) {
    if (Object.prototype.hasOwnProperty.call(record, "value")) {
      return normalizeFormValue(record.value);
    }
    if (Object.prototype.hasOwnProperty.call(record, "option")) {
      return normalizeFormValue(record.option);
    }
    if (Object.prototype.hasOwnProperty.call(record, "text")) {
      return normalizeFormValue(record.text);
    }
    if (Object.prototype.hasOwnProperty.call(record, "open_id")) {
      return normalizeFormValue(record.open_id);
    }
    if (Object.prototype.hasOwnProperty.call(record, "user_id")) {
      return normalizeFormValue(record.user_id);
    }
    if (Object.prototype.hasOwnProperty.call(record, "id")) {
      return normalizeFormValue(record.id);
    }
  }

  return value;
}

function normalizeEditedPayload(value: unknown): unknown | undefined {
  if (value === undefined || value === null || isTemplatePlaceholder(value)) {
    return undefined;
  }

  const record = asRecord(value);
  if (record === null) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, rawFieldValue] of Object.entries(record)) {
    if (INTERNAL_CARD_VALUE_KEYS.has(key)) {
      continue;
    }

    const fieldValue = normalizeFormValue(rawFieldValue);
    if (fieldValue !== undefined) {
      normalized[key] = fieldValue;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function extractCardCallbackPayload(payload: unknown): {
  requestId: string | null;
  actionKey: string | null;
  editedPayload?: unknown;
  reason?: string | null;
  updateToken?: string | null;
  messageId?: string | null;
  chatId?: string | null;
  actorOpenId?: string | null;
} {
  const root = asRecord(payload) ?? {};
  const event = recordAtPath(payload, ["event"]) ?? {};
  const actionValue = firstRecord([
    recordAtPath(payload, ["event", "action", "value"]),
    recordAtPath(payload, ["action", "value"]),
    recordAtPath(payload, ["event", "action", "value", "payload"]),
    recordAtPath(payload, ["action", "value", "payload"]),
    recordAtPath(payload, ["event", "action"]),
    recordAtPath(payload, ["action"]),
    recordAtPath(payload, ["value"]),
    asRecord(payload)
  ]);
  const requestId = firstString([
    actionValue.confirmation_id,
    actionValue.request_id,
    root.confirmation_id,
    root.request_id,
    event.confirmation_id,
    event.request_id,
    valueAtPath(payload, ["event", "confirmation_id"]),
    valueAtPath(payload, ["event", "request_id"])
  ]);
  const actionKey = firstString([
    actionValue.action,
    actionValue.action_key,
    actionValue.key,
    root.action,
    root.action_key,
    valueAtPath(payload, ["event", "action"]),
    valueAtPath(payload, ["event", "action_key"])
  ]);
  const editedPayload = normalizeEditedPayload(
    valueFromActionPayload(actionValue, "edited_payload") ??
      recordAtPath(payload, ["event", "action", "form_value"]) ??
      recordAtPath(payload, ["action", "form_value"]) ??
      recordAtPath(payload, ["event", "form_value"]) ??
      recordAtPath(payload, ["form_value"])
  );
  const reasonValue = valueFromActionPayload(actionValue, "reason");
  const reason = stringValue(reasonValue);
  const updateToken = firstString([
    valueAtPath(payload, ["event", "token"]),
    valueAtPath(payload, ["event", "context", "token"]),
    valueAtPath(payload, ["event", "action", "token"]),
    valueAtPath(payload, ["action", "token"]),
    root.token
  ]);
  const messageId = firstString([
    valueAtPath(payload, ["event", "context", "open_message_id"]),
    valueAtPath(payload, ["event", "context", "message_id"]),
    valueAtPath(payload, ["event", "message", "message_id"]),
    valueAtPath(payload, ["event", "message_id"]),
    root.open_message_id,
    root.message_id
  ]);
  const chatId = firstString([
    valueAtPath(payload, ["event", "context", "open_chat_id"]),
    valueAtPath(payload, ["event", "context", "chat_id"]),
    valueAtPath(payload, ["event", "message", "chat_id"]),
    valueAtPath(payload, ["event", "chat_id"]),
    root.open_chat_id,
    root.chat_id
  ]);
  const actorOpenId = firstString([
    valueAtPath(payload, ["event", "operator", "user_id", "open_id"]),
    valueAtPath(payload, ["event", "operator", "open_id"]),
    valueAtPath(payload, ["event", "operator", "operator_id", "open_id"]),
    valueAtPath(payload, ["event", "user_id", "open_id"]),
    valueAtPath(payload, ["event", "open_id"]),
    root.open_id,
    root.user_id
  ]);

  return {
    requestId,
    actionKey,
    editedPayload,
    reason,
    updateToken,
    messageId,
    chatId,
    actorOpenId
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function withDryRunCard(request: ReturnType<Repositories["getConfirmationRequest"]>) {
  if (request === null) {
    return null;
  }

  return {
    ...request,
    dry_run_card: buildConfirmationCardFromRequest(request)
  };
}

function isUnfinishedConfirmation(
  request: ReturnType<Repositories["listConfirmationRequests"]>[number]
): boolean {
  return !["executed", "rejected", "failed"].includes(request.status);
}

function cardPreviewStubAction(input: {
  repos: Repositories;
  id: string;
  action: "remind_later" | "convert_to_task" | "append_current_only";
}) {
  const confirmation = input.repos.getConfirmationRequest(input.id);
  if (confirmation === null) {
    return null;
  }

  return {
    ok: true,
    dry_run: true,
    confirmation_id: input.id,
    action: input.action,
    status: "preview_only",
    message: CardActionPendingMessage
  };
}

function alreadyProcessedResponse(input: { confirmation: ConfirmationRequestRow }) {
  return cardCallbackResponse({
    type: "info",
    content: `该确认请求已处理（${input.confirmation.status}），不会重复执行`,
    confirmation: input.confirmation
  });
}

function alreadyProcessingResponse(input: { confirmation: ConfirmationRequestRow }) {
  return cardCallbackResponse({
    type: "info",
    content: "该确认请求正在处理中，不会重复执行",
    confirmation: input.confirmation
  });
}

function cardStatusLogContext(input: {
  confirmationId: string;
  phase: string;
  result: Awaited<ReturnType<typeof syncConfirmationCardStatus>>;
}) {
  return {
    confirmation_id: input.confirmationId,
    phase: input.phase,
    card_status_method: input.result.method,
    card_status_ok: input.result.ok,
    card_status_error: input.result.error
  };
}

async function syncCardStatusForRequest(input: {
  repos: Repositories;
  config: AppConfig;
  request: ConfirmationRequestRow;
  updateToken?: string | null;
  messageId?: string | null;
  chatId?: string | null;
  runner?: LarkCliRunner;
}) {
  const latest = input.repos.getConfirmationRequest(input.request.id) ?? input.request;
  return syncConfirmationCardStatus({
    repos: input.repos,
    config: input.config,
    confirmation: latest,
    card: buildConfirmationCardFromRequest(latest),
    updateToken: input.updateToken,
    messageId: input.messageId,
    chatId: input.chatId,
    runner: input.runner
  });
}

function sendCardStatusCode(result: { ok: boolean; error: string | null }): number {
  if (result.ok) {
    return 200;
  }

  return result.error?.includes("requires recipient or chat_id") ? 400 : 502;
}

function automaticCardDestination(input: {
  confirmation: ConfirmationRequestRow;
  sendToChatId?: string | null;
}): { recipient: string | null; chatId: string | null } {
  if (PERSONAL_KNOWLEDGE_REQUEST_TYPES.has(input.confirmation.request_type)) {
    return {
      recipient: input.confirmation.recipient,
      chatId: null
    };
  }

  const chatId = stringValue(input.sendToChatId);
  return {
    recipient: chatId === null ? input.confirmation.recipient : null,
    chatId
  };
}

function bulkCardDestination(input: {
  confirmation: ConfirmationRequestRow;
  recipient?: string | null;
  chatId?: string | null;
}): { recipient: string | null; chatId: string | null } {
  const explicitRecipient = stringValue(input.recipient);
  if (PERSONAL_KNOWLEDGE_REQUEST_TYPES.has(input.confirmation.request_type)) {
    return {
      recipient: explicitRecipient ?? input.confirmation.recipient,
      chatId: null
    };
  }

  const chatId = stringValue(input.chatId);
  return {
    recipient: chatId === null ? (explicitRecipient ?? input.confirmation.recipient) : null,
    chatId
  };
}

async function sendGeneratedConfirmationCards(input: {
  repos: Repositories;
  config: AppConfig;
  confirmationIds: string[];
  sendToChatId?: string | null;
  runner?: LarkCliRunner;
}) {
  if (input.config.feishuCardSendDryRun || input.confirmationIds.length === 0) {
    return [];
  }

  const results: Awaited<ReturnType<typeof sendCard>>[] = [];
  for (const confirmationId of input.confirmationIds) {
    const confirmation = input.repos.getConfirmationRequest(confirmationId);
    if (confirmation === null) {
      continue;
    }

    const destination = automaticCardDestination({
      confirmation,
      sendToChatId: input.sendToChatId
    });
    if (destination.chatId === null && destination.recipient === null) {
      continue;
    }

    results.push(
      await sendCard({
        repos: input.repos,
        config: input.config,
        confirmation,
        card: buildConfirmationCardFromRequest(confirmation),
        recipient: destination.recipient,
        chatId: destination.chatId,
        runner: input.runner
      })
    );
  }

  return results;
}

export function buildServer(input: {
  config: AppConfig;
  repos: Repositories;
  llm: LlmClient;
  larkCliRunner?: LarkCliRunner;
}) {
  const app = Fastify({
    logger: true
  });
  configureJsonBodyParser(app);

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/dev")) {
      return;
    }

    const devApiKey = input.config.devApiKey;
    if (!devApiKey) {
      return;
    }

    if (request.headers["x-dev-api-key"] !== devApiKey) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: "meeting-atlas",
    phase: "phase-6",
    dry_run: input.config.feishuDryRun,
    read_dry_run: input.config.feishuReadDryRun,
    card_send_dry_run: input.config.feishuCardSendDryRun,
    task_create_dry_run: input.config.feishuTaskCreateDryRun,
    calendar_create_dry_run: input.config.feishuCalendarCreateDryRun,
    knowledge_write_dry_run: input.config.feishuKnowledgeWriteDryRun,
    llm_provider: input.config.llmProvider,
    sqlite_path: input.config.sqlitePath
  }));

  app.post("/webhooks/feishu/event", async (request, reply) => {
    const rawBody = getRawBody(request);
    const payload = (request.body ?? {}) as FeishuEventWebhookPayload;
    if (typeof payload.challenge === "string") {
      return { challenge: payload.challenge };
    }

    if (
      !isLarkSignatureValid({
        request,
        body: rawBody,
        verificationToken: input.config.larkVerificationToken
      })
    ) {
      request.log.warn(
        getLarkSignatureDiagnostics(request),
        "rejected feishu event webhook with invalid signature"
      );
      return reply.code(401).send({ error: "Invalid Lark webhook signature" });
    }

    const eventType = getFeishuEventType(payload);
    request.log.info({ event_type: eventType }, "received feishu event webhook");

    if (eventType === FeishuRecordingReadyEventType) {
      const event = FeishuRecordingReadyEventSchema.parse(payload.event ?? {});
      const organizer = event.operator_id?.open_id ?? event.host_user_id?.open_id ?? null;
      const externalMeetingId = event.meeting_id ?? event.minute_token ?? "unknown";
      const title = event.topic?.trim() || externalMeetingId;

      void (async () => {
        // 等待妙记生成
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const transcript = await withTimeout(
          fetchTranscript({
            repos: input.repos,
            config: input.config,
            meetingId: externalMeetingId,
            title,
            minuteToken: event.minute_token ?? null,
            runner: input.larkCliRunner
          }).catch((error) => {
            request.log.warn(
              { err: error, external_meeting_id: externalMeetingId },
              "failed to fetch transcript for feishu recording_ready event; using fallback text"
            );
            return TranscriptPendingText;
          }),
          TranscriptFetchTimeoutMs,
          TranscriptPendingText
        );

        const result = await processMeetingWorkflow({
          repos: input.repos,
          llm: input.llm,
          meeting: {
            external_meeting_id: externalMeetingId,
            title,
            participants: organizer === null ? [] : [organizer],
            organizer,
            started_at: null,
            ended_at: null,
            transcript_text: transcript
          }
        });
        const cardSendResults = await sendGeneratedConfirmationCards({
          repos: input.repos,
          config: input.config,
          confirmationIds: result.confirmation_requests,
          runner: input.larkCliRunner
        });

        request.log.info(
          {
            event_type: eventType,
            external_meeting_id: externalMeetingId,
            meeting_id: result.meeting_id,
            confirmation_requests: result.confirmation_requests.length,
            card_send_results: cardSendResults.length,
            transcript_preview: transcript.slice(0, 80)
          },
          "triggered meeting workflow from feishu recording_ready event"
        );
      })().catch((error) => {
        request.log.error(
          {
            event_type: eventType,
            external_meeting_id: externalMeetingId,
            err: error
          },
          "failed meeting workflow from feishu recording_ready event"
        );
      });

      return reply.code(202).send({ accepted: true });
    }

    request.log.info({ event_type: eventType }, "accepted unsupported feishu event webhook");
    return reply.code(202).send({ accepted: true });
  });

  app.post("/webhooks/feishu/card-action", async (request, reply) => {
    const rawBody = getRawBody(request);
    const bodyRecord = asRecord(request.body ?? {});
    if (bodyRecord !== null && typeof bodyRecord.challenge === "string") {
      return { challenge: bodyRecord.challenge };
    }

    if (
      !isLarkCardActionSignatureValid({
        request,
        rawBody,
        body: request.body ?? {},
        verificationToken: input.config.larkVerificationToken
      })
    ) {
      request.log.warn(
        getLarkSignatureDiagnostics(request),
        "rejected feishu card action webhook with invalid signature"
      );
      return reply.code(401).send({ error: "Invalid Lark webhook signature" });
    }

    const parsed = extractCardCallbackPayload(request.body ?? {});

    if (parsed.requestId === null) {
      return toast("error", "确认请求不存在");
    }

    const requestId = parsed.requestId;
    const confirmation = input.repos.getConfirmationRequest(requestId);
    if (confirmation === null) {
      return toast("error", "确认请求不存在");
    }

    if (parsed.messageId && confirmation.card_message_id === null) {
      input.repos.updateConfirmationCardMessage({
        id: confirmation.id,
        card_message_id: parsed.messageId
      });
    }

    if (parsed.actionKey === null) {
      return toast("error", "暂不支持此操作");
    }

    if (PROCESSED_CONFIRMATION_STATUSES.has(confirmation.status)) {
      return alreadyProcessedResponse({ confirmation });
    }

    if (IN_FLIGHT_CONFIRMATION_STATUSES.has(confirmation.status)) {
      return alreadyProcessingResponse({ confirmation });
    }

    try {
      if (CONFIRM_CARD_ACTION_KEYS.has(parsed.actionKey)) {
        input.repos.updateConfirmationRequest({
          id: requestId,
          status: "confirmed",
          edited_payload_json:
            parsed.editedPayload === undefined ? null : JSON.stringify(parsed.editedPayload),
          confirmed_at: nowIso(),
          error: null
        });
        const acceptedConfirmation = input.repos.getConfirmationRequest(requestId) ?? confirmation;

        void (async () => {
          const execution = await confirmRequest({
            repos: input.repos,
            config: input.config,
            id: requestId,
            editedPayload: parsed.editedPayload,
            actorOpenId: parsed.actorOpenId,
            runner: input.larkCliRunner
          });
          const finalUpdate = await syncCardStatusForRequest({
            repos: input.repos,
            config: input.config,
            request: execution.confirmation,
            updateToken: parsed.updateToken,
            messageId: parsed.messageId,
            chatId: parsed.chatId,
            runner: input.larkCliRunner
          });
          if (!finalUpdate.ok) {
            request.log.warn(
              cardStatusLogContext({
                confirmationId: requestId,
                phase: "final",
                result: finalUpdate
              }),
              "card status update fell back or failed after execution"
            );
          }
        })().catch(async (error) => {
          input.repos.updateConfirmationRequest({
            id: requestId,
            status: "failed",
            error: briefError(error)
          });
          const failed = input.repos.getConfirmationRequest(requestId) ?? confirmation;
          const finalUpdate = await syncCardStatusForRequest({
            repos: input.repos,
            config: input.config,
            request: failed,
            updateToken: parsed.updateToken,
            messageId: parsed.messageId,
            chatId: parsed.chatId,
            runner: input.larkCliRunner
          });
          request.log.error(
            {
              err: error,
              confirmation_id: requestId,
              card_status_method: finalUpdate.method,
              card_status_ok: finalUpdate.ok
            },
            "async confirm failed"
          );
        });

        return cardCallbackResponse({
          type: "info",
          content: CardActionAcceptedMessage,
          confirmation: acceptedConfirmation
        });
      }

      if (REJECT_CARD_ACTION_KEYS.has(parsed.actionKey)) {
        const rejected = rejectRequest({
          repos: input.repos,
          id: requestId,
          reason: parsed.reason ?? parsed.actionKey
        });

        void syncCardStatusForRequest({
          repos: input.repos,
          config: input.config,
          request: rejected,
          updateToken: parsed.updateToken,
          messageId: parsed.messageId,
          chatId: parsed.chatId,
          runner: input.larkCliRunner
        }).catch((error) => {
          request.log.error(
            { err: error, confirmation_id: requestId },
            "failed to update rejected card status"
          );
        });

        return cardCallbackResponse({
          type: "success",
          content: "已拒绝",
          confirmation: rejected
        });
      }

      const previewAction =
        PREVIEW_STUB_CARD_ACTIONS[parsed.actionKey as keyof typeof PREVIEW_STUB_CARD_ACTIONS];
      if (previewAction !== undefined) {
        const result = cardPreviewStubAction({
          repos: input.repos,
          id: requestId,
          action: previewAction
        });
        if (result === null) {
          return toast("error", "确认请求不存在");
        }

        const latest = input.repos.getConfirmationRequest(requestId) ?? confirmation;
        const pendingCard = {
          ...buildConfirmationCardFromRequest(latest),
          status_text: "已收到，稍后处理",
          actions: []
        };
        void syncConfirmationCardStatus({
          repos: input.repos,
          config: input.config,
          confirmation: latest,
          card: pendingCard,
          updateToken: parsed.updateToken,
          messageId: parsed.messageId,
          chatId: parsed.chatId,
          runner: input.larkCliRunner
        }).catch((error) => {
          request.log.error(
            { err: error, confirmation_id: requestId, action: parsed.actionKey },
            "failed to update preview card status"
          );
        });

        return {
          ...toast("info", CardActionPendingMessage),
          card: buildFeishuInteractiveCard(pendingCard)
        };
      }

      return toast("error", "暂不支持此操作");
    } catch (error) {
      request.log.error(
        { err: error, confirmation_id: requestId, action: parsed.actionKey },
        "card action failed"
      );
      return toast("error", briefError(error));
    }
  });

  app.post("/dev/llm/smoke-test", async (request, reply) => {
    const body = LlmSmokeTestInputSchema.parse(request.body);
    const now = nowIso();
    const meeting: MeetingRow = {
      id: "smoke_test",
      external_meeting_id: null,
      title: "LLM smoke test",
      started_at: now,
      ended_at: null,
      organizer: "smoke-test",
      participants_json: JSON.stringify(["张三"]),
      minutes_url: null,
      transcript_url: null,
      transcript_text: body.text,
      summary: null,
      keywords_json: JSON.stringify([]),
      matched_kb_id: null,
      match_score: null,
      archive_status: "not_archived",
      action_count: 0,
      calendar_count: 0,
      created_at: now,
      updated_at: now
    };

    try {
      const result = await runMeetingExtractionAgent({
        meeting,
        llm: input.llm
      });

      return {
        provider: input.config.llmProvider,
        model: input.config.llmModel ?? input.config.llmProvider,
        ok: true,
        result
      };
    } catch (error) {
      return reply.code(500).send({
        provider: input.config.llmProvider,
        model: input.config.llmModel ?? input.config.llmProvider,
        ok: false,
        error: briefError(error)
      });
    }
  });

  app.post("/dev/meetings/manual", async (request) => {
    const meeting = ManualMeetingInputSchema.parse(request.body);
    const result = await processMeetingWorkflow({
      repos: input.repos,
      llm: input.llm,
      meeting
    });
    await sendGeneratedConfirmationCards({
      repos: input.repos,
      config: input.config,
      confirmationIds: result.confirmation_requests,
      sendToChatId: meeting.send_to_chat_id,
      runner: input.larkCliRunner
    });

    return result;
  });

  app.post("/dev/meetings/process-text", async (request) => {
    const body = ProcessMeetingTextInputSchema.parse(request.body);

    return processMeetingTextToConfirmationsWorkflow({
      repos: input.repos,
      llm: input.llm,
      meeting: body.meeting,
      personalWorkspaceName: body.personal_workspace_name
    });
  });

  app.get("/dev/confirmations", async () =>
    input.repos.listConfirmationRequests().map((request) => ({
      ...request,
      dry_run_card: buildConfirmationCardFromRequest(request)
    }))
  );

  app.get("/dev/cards", async () =>
    input.repos
      .listConfirmationRequests()
      .filter(isUnfinishedConfirmation)
      .map((request) => buildConfirmationCardFromRequest(request))
  );

  app.get("/dev/confirmations/:id/card", async (request, reply) => {
    const params = request.params as { id: string };
    const confirmation = withDryRunCard(input.repos.getConfirmationRequest(params.id));
    if (!confirmation) {
      return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
    }

    return confirmation.dry_run_card;
  });

  app.post("/dev/confirmations/:id/send-card", async (request, reply) => {
    const params = request.params as { id: string };
    const body = SendCardBodySchema.parse(request.body ?? {});
    const confirmation = input.repos.getConfirmationRequest(params.id);
    if (!confirmation) {
      return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
    }

    const card = buildConfirmationCardFromRequest(confirmation);
    const result = await sendCard({
      repos: input.repos,
      config: input.config,
      confirmation,
      card,
      recipient: body.recipient,
      chatId: body.chat_id,
      identity: body.identity,
      runner: input.larkCliRunner
    });

    return reply.code(sendCardStatusCode(result)).send({
      confirmation_id: confirmation.id,
      card_type: card.card_type,
      ...result
    });
  });

  app.post("/dev/cards/send-all", async (request) => {
    const body = SendCardBodySchema.parse(request.body ?? {});
    const results: Array<
      Awaited<ReturnType<typeof sendCard>> & {
        confirmation_id: string;
        card_type: string;
      }
    > = [];
    for (const confirmation of input.repos
      .listConfirmationRequests()
      .filter(isUnfinishedConfirmation)) {
      const card = buildConfirmationCardFromRequest(confirmation);
      const destination = bulkCardDestination({
        confirmation,
        recipient: body.recipient,
        chatId: body.chat_id
      });
      const result = await sendCard({
        repos: input.repos,
        config: input.config,
        confirmation,
        card,
        recipient: destination.recipient,
        chatId: destination.chatId,
        identity: body.identity,
        runner: input.larkCliRunner
      });

      results.push({
        confirmation_id: confirmation.id,
        card_type: card.card_type,
        ...result
      });
    }

    return {
      ok: results.every((result) => result.ok),
      total: results.length,
      planned: results.filter((result) => result.status === "planned").length,
      sent: results.filter((result) => result.status === "sent").length,
      failed: results.filter((result) => result.status === "failed").length,
      results
    };
  });

  app.post("/dev/confirmations/:id/confirm", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { edited_payload?: unknown };
    return confirmRequest({
      repos: input.repos,
      config: input.config,
      id: params.id,
      editedPayload: body.edited_payload,
      runner: input.larkCliRunner
    });
  });

  app.post("/dev/confirmations/:id/reject", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string | null };
    return {
      confirmation: rejectRequest({
        repos: input.repos,
        id: params.id,
        reason: body.reason
      })
    };
  });

  app.post("/dev/confirmations/:id/complete-owner", async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { edited_payload?: unknown; actor_open_id?: unknown };
    try {
      const result = await confirmRequest({
        repos: input.repos,
        config: input.config,
        id: params.id,
        editedPayload: normalizeEditedPayload(body.edited_payload ?? request.body),
        actorOpenId: stringValue(body.actor_open_id),
        runner: input.larkCliRunner
      });
      return {
        ok: true,
        dry_run: true,
        completion: "task_requested",
        confirmation: result.confirmation,
        result: result.result,
        dry_run_card: buildConfirmationCardFromRequest(result.confirmation)
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("Confirmation request not found")) {
        return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
      }

      throw error;
    }
  });

  app.post("/dev/confirmations/:id/remind-later", async (request, reply) => {
    const params = request.params as { id: string };
    const result = cardPreviewStubAction({
      repos: input.repos,
      id: params.id,
      action: "remind_later"
    });

    if (result === null) {
      return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
    }

    return result;
  });

  app.post("/dev/confirmations/:id/convert-to-task", async (request, reply) => {
    const params = request.params as { id: string };
    const result = cardPreviewStubAction({
      repos: input.repos,
      id: params.id,
      action: "convert_to_task"
    });

    if (result === null) {
      return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
    }

    return result;
  });

  app.post("/dev/confirmations/:id/append-current-only", async (request, reply) => {
    const params = request.params as { id: string };
    const result = cardPreviewStubAction({
      repos: input.repos,
      id: params.id,
      action: "append_current_only"
    });

    if (result === null) {
      return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
    }

    return result;
  });

  app.get("/dev/card-send-runs", async () =>
    input.repos
      .listCliRuns()
      .filter((run) => run.tool === "lark.im.send_card")
      .slice(-20)
      .map((run) => ({
        id: run.id,
        dry_run: run.dry_run,
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        error: run.error,
        created_at: run.created_at
      }))
  );

  app.get("/dev/state", async () => input.repos.getStateSummary());

  return app;
}
