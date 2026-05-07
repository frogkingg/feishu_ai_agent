import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { AppConfig, getCardCallbackReadiness, getFeishuWebhookReadiness } from "./config";
import { ManualMeetingInputSchema, ProcessMeetingTextInputSchema } from "./schemas";
import { buildConfirmationCardFromRequest } from "./agents/cardInteractionAgent";
import { runMeetingExtractionAgent } from "./agents/meetingExtractionAgent";
import { runQaAgent } from "./agents/qaAgent";
import {
  appendCurrentOnlyConfirmation,
  confirmRequest,
  convertCalendarConfirmationToActionConfirmation,
  rejectRequest,
  snoozeConfirmation
} from "./services/confirmationService";
import { LlmClient } from "./services/llm/llmClient";
import { createDatabase } from "./services/store/db";
import { ConfirmationRequestRow, MeetingRow, Repositories } from "./services/store/repositories";
import { buildFeishuInteractiveCard, sendCard, syncConfirmationCardStatus } from "./tools/larkIm";
import { type LarkCliRunner } from "./tools/larkCli";
import { fetchTranscript } from "./tools/larkVc";
import { nowIso } from "./utils/dates";
import { createId } from "./utils/id";
import {
  decryptLarkPayload,
  verifyLarkCardActionSignature,
  verifyLarkWebhookSignature
} from "./utils/larkSignature";
import {
  processMeetingTextToConfirmationsWorkflow,
  processMeetingWorkflow
} from "./workflows/processMeetingWorkflow";

const LlmSmokeTestInputSchema = z.object({
  text: z.string().min(1)
});
const KnowledgeBaseAskBodySchema = z.object({
  question: z.string().trim().min(1)
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
const FeishuMeetingEndedEventType = "vc.meeting.all_meeting_ended_v1";
const TranscriptPendingText = "【transcript pending - to be fetched via lark-cli vc +notes】";
const CardActionConfirmedMessage = "已确认，处理完成";
const CardActionSnoozedMessage = "好的，30 分钟后再提醒你";
const RemindLaterDelayMinutes = 30;
const RecordingReadyTranscriptWaitMs = 0;
const RecordingReadyTranscriptFetchTimeoutMs = 15000;
const MeetingEndedTranscriptRetryDelaysMs = [60000, 240000, 300000, 120000] as const;
const TestMeetingEndedTranscriptRetryDelaysMs = [0, 0, 0, 0] as const;
const MeetingEndedTranscriptFetchTimeoutMs = 15000;
const LarkSignatureFreshnessWindowSeconds = 5 * 60;

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
    event_id?: unknown;
  };
  event_id?: unknown;
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

function getLarkTimestampCandidates(timestamp: string | null): string[] {
  if (timestamp === null) {
    return [];
  }

  const trimmed = timestamp.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const candidates = [trimmed];
  const firstCommaToken = trimmed.split(",")[0]?.trim() ?? "";
  if (/^\d+(?:\.\d+)?$/.test(firstCommaToken) && !candidates.includes(firstCommaToken)) {
    candidates.push(firstCommaToken);
  }

  for (const match of trimmed.matchAll(/(?:^|[^\d])(\d{10,19}(?:\.\d+)?)(?!\d)/g)) {
    const epochLikeToken = match[1];
    if (epochLikeToken !== undefined && !candidates.includes(epochLikeToken)) {
      candidates.push(epochLikeToken);
    }
  }

  return candidates;
}

function parseStrictLarkDateTimeTimestampSeconds(timestamp: string): number | null {
  const match = timestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|\s*([+-])(\d{2})(?::?(\d{2})))(?:\s+[A-Z]{2,5})?(?:\s+m=[+-]?\d+(?:\.\d+)?)?$/
  );
  if (match === null) {
    return null;
  }

  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue, fractionValue, offsetSign, offsetHourValue, offsetMinuteValue] =
    match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  const millisecond = Number((fractionValue ?? "").padEnd(3, "0").slice(0, 3));
  const offsetHour = offsetHourValue === undefined ? 0 : Number(offsetHourValue);
  const offsetMinute = offsetMinuteValue === undefined ? 0 : Number(offsetMinuteValue);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const offsetDirection = offsetSign === "-" ? -1 : 1;
  const offsetMilliseconds = offsetDirection * (offsetHour * 60 + offsetMinute) * 60 * 1000;
  const timestampMilliseconds =
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMilliseconds;
  const parsedDate = new Date(timestampMilliseconds + offsetMilliseconds);
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day ||
    parsedDate.getUTCHours() !== hour ||
    parsedDate.getUTCMinutes() !== minute ||
    parsedDate.getUTCSeconds() !== second
  ) {
    return null;
  }

  const timestampSeconds = Math.floor(timestampMilliseconds / 1000);
  return Number.isSafeInteger(timestampSeconds) ? timestampSeconds : null;
}

function getLarkTimestampFreshnessSeconds(timestamp: string): number | null {
  const trimmed = timestamp.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return parseStrictLarkDateTimeTimestampSeconds(trimmed);
  }

  const timestampNumber = Number(trimmed);
  if (!Number.isFinite(timestampNumber)) {
    return null;
  }

  const integerDigits = trimmed.split(".")[0]?.length ?? 0;
  const timestampSeconds =
    integerDigits >= 19
      ? Math.floor(timestampNumber / 1_000_000_000)
      : integerDigits >= 16
        ? Math.floor(timestampNumber / 1_000_000)
        : integerDigits >= 13
          ? Math.floor(timestampNumber / 1000)
          : Math.floor(timestampNumber);

  return Number.isSafeInteger(timestampSeconds) ? timestampSeconds : null;
}

function getLarkTimestampCandidateFailureReason(timestamp: string): string {
  const timestampSeconds = getLarkTimestampFreshnessSeconds(timestamp);
  if (timestampSeconds === null) {
    return "invalid_timestamp";
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (timestampSeconds < nowSeconds - LarkSignatureFreshnessWindowSeconds) {
    return "stale_timestamp";
  }

  if (timestampSeconds > nowSeconds + LarkSignatureFreshnessWindowSeconds) {
    return "future_timestamp";
  }

  return "fresh_timestamp";
}

function getFreshLarkTimestampCandidates(timestamp: string | null): string[] {
  return getLarkTimestampCandidates(timestamp).filter(
    (candidate) => getLarkTimestampCandidateFailureReason(candidate) === "fresh_timestamp"
  );
}

function getLarkSignatureTimestampFailureReason(timestamp: string | null): string | null {
  if (timestamp === null) {
    return "missing_timestamp";
  }

  const candidateReasons = getLarkTimestampCandidates(timestamp).map(getLarkTimestampCandidateFailureReason);
  if (candidateReasons.length === 0) {
    return "invalid_timestamp";
  }

  if (candidateReasons.includes("fresh_timestamp")) {
    return null;
  }

  if (candidateReasons.includes("stale_timestamp")) {
    return "stale_timestamp";
  }

  if (candidateReasons.includes("future_timestamp")) {
    return "future_timestamp";
  }

  if (candidateReasons.includes("invalid_timestamp")) {
    return "invalid_timestamp";
  }

  return null;
}

function describeLarkTimestampShape(timestamp: string | null): Record<string, unknown> {
  const prefixClass = (() => {
    if (timestamp === null || timestamp.length === 0) {
      return "missing";
    }

    const firstCharacter = timestamp.trimStart()[0];
    if (firstCharacter === undefined) {
      return "missing";
    }
    if (/\d/.test(firstCharacter)) {
      return "digit";
    }
    if (/[A-Za-z]/.test(firstCharacter)) {
      return "alpha";
    }
    if (firstCharacter === '"' || firstCharacter === "'") {
      return "quote";
    }
    if ("[]{}()".includes(firstCharacter)) {
      return "bracket";
    }
    return "other";
  })();

  return {
    timestamp_length: timestamp?.length ?? 0,
    timestamp_digit_run_lengths:
      timestamp === null
        ? []
        : Array.from(timestamp.matchAll(/\d+/g), (match) => match[0].length).slice(0, 8),
    timestamp_has_alpha: timestamp === null ? false : /[A-Za-z]/.test(timestamp),
    timestamp_has_colon: timestamp?.includes(":") ?? false,
    timestamp_has_dash: timestamp?.includes("-") ?? false,
    timestamp_has_t: timestamp === null ? false : /t/i.test(timestamp),
    timestamp_has_z: timestamp === null ? false : /z/i.test(timestamp),
    timestamp_has_dot: timestamp?.includes(".") ?? false,
    timestamp_has_comma: timestamp?.includes(",") ?? false,
    timestamp_has_equals: timestamp?.includes("=") ?? false,
    timestamp_has_quote: timestamp === null ? false : /["']/.test(timestamp),
    timestamp_has_bracket: timestamp === null ? false : /[\[\]{}()]/.test(timestamp),
    timestamp_has_space: timestamp === null ? false : /\s/.test(timestamp),
    timestamp_prefix_class: prefixClass
  };
}

function isLarkSignatureValid(input: {
  request: FastifyRequest;
  body: string;
  verificationToken: string | null;
  encryptKey?: string | null;
}): boolean {
  const timestamp = getHeaderString(input.request, "x-lark-request-timestamp");
  const nonce = getHeaderString(input.request, "x-lark-request-nonce");
  const signature = getHeaderString(input.request, "x-lark-signature");

  if (timestamp === null || nonce === null || signature === null) {
    return false;
  }

  const timestampCandidates = getFreshLarkTimestampCandidates(timestamp);
  if (timestampCandidates.length === 0) {
    return false;
  }

  const encryptKey = input.encryptKey;
  if (encryptKey) {
    return timestampCandidates.some((timestampCandidate) =>
      verifyLarkWebhookSignature({
        timestamp: timestampCandidate,
        nonce,
        body: input.body,
        verificationToken: encryptKey,
        signature
      })
    );
  }

  if (input.verificationToken === null) {
    return false;
  }
  const verificationToken = input.verificationToken;

  // Compatibility for old local fixtures. Production Feishu webhook signatures use Encrypt Key.
  return timestampCandidates.some((timestampCandidate) =>
    verifyLarkWebhookSignature({
      timestamp: timestampCandidate,
      nonce,
      body: input.body,
      verificationToken,
      signature
    })
  );
}

function isLarkCardActionSignatureValid(input: {
  request: FastifyRequest;
  rawBody: string;
  body: unknown;
  verificationToken: string | null;
  encryptKey?: string | null;
}): boolean {
  const timestamp = getHeaderString(input.request, "x-lark-request-timestamp");
  const nonce = getHeaderString(input.request, "x-lark-request-nonce");
  const signature = getHeaderString(input.request, "x-lark-signature");

  if (timestamp === null || nonce === null || signature === null) {
    return false;
  }

  const timestampCandidates = getFreshLarkTimestampCandidates(timestamp);
  if (timestampCandidates.length === 0) {
    return false;
  }

  const encryptKey = input.encryptKey;
  if (encryptKey) {
    const encryptKeySignatureValid = timestampCandidates.some((timestampCandidate) =>
      verifyLarkWebhookSignature({
        timestamp: timestampCandidate,
        nonce,
        body: input.rawBody,
        verificationToken: encryptKey,
        signature
      })
    );
    if (encryptKeySignatureValid) {
      return true;
    }
  }

  if (input.verificationToken === null) {
    return false;
  }
  const verificationToken = input.verificationToken;

  if (
    timestampCandidates.some((timestampCandidate) =>
      verifyLarkWebhookSignature({
        timestamp: timestampCandidate,
        nonce,
        body: input.rawBody,
        verificationToken,
        signature
      })
    )
  ) {
    return true;
  }

  return timestampCandidates.some((timestampCandidate) =>
    verifyLarkCardActionSignature({
      timestamp: timestampCandidate,
      nonce,
      body: input.body,
      verificationToken,
      signature
    })
  );
}

function getLarkSignatureDiagnostics(request: FastifyRequest): Record<string, unknown> {
  const timestamp = getHeaderString(request, "x-lark-request-timestamp");
  const nonce = getHeaderString(request, "x-lark-request-nonce");
  const signature = getHeaderString(request, "x-lark-signature");
  const timestampFailureReason = getLarkSignatureTimestampFailureReason(timestamp);
  const timestampCandidates = getLarkTimestampCandidates(timestamp);

  return {
    has_timestamp: timestamp !== null,
    has_nonce: nonce !== null,
    has_signature: signature !== null,
    ...describeLarkTimestampShape(timestamp),
    timestamp_candidate_count: timestampCandidates.length,
    timestamp_failure_reason: timestampFailureReason,
    reason:
      timestampFailureReason ??
      (nonce === null
        ? "missing_nonce"
        : signature === null
          ? "missing_signature"
          : "signature_mismatch")
  };
}

function verificationTokenInPayload(payload: Record<string, unknown> | null): string | null {
  if (payload === null) {
    return null;
  }

  return firstString([
    payload.token,
    valueAtPath(payload, ["header", "token"]),
    valueAtPath(payload, ["event", "token"])
  ]);
}

function hasValidVerificationToken(input: {
  payload: Record<string, unknown> | null;
  verificationToken: string | null;
}): boolean {
  if (input.verificationToken === null) {
    return true;
  }

  return verificationTokenInPayload(input.payload) === input.verificationToken;
}

function allowsLocalSecurityBypass(config: Pick<AppConfig, "nodeEnv">): boolean {
  return config.nodeEnv === "development" || config.nodeEnv === "test";
}

function allowsUnsignedLocalWebhook(
  config: Pick<AppConfig, "nodeEnv" | "larkVerificationToken" | "larkEncryptKey">
): boolean {
  return (
    allowsLocalSecurityBypass(config) &&
    config.larkVerificationToken === null &&
    config.larkEncryptKey === null
  );
}

function decryptFeishuPayloadIfEncrypted(
  body: Record<string, unknown>,
  encryptKey: string | null
): { decrypted: boolean; payload: Record<string, unknown> } {
  if (typeof body.encrypt === "string" && encryptKey) {
    const decryptedJson = decryptLarkPayload(body.encrypt, encryptKey);
    const payload = JSON.parse(decryptedJson) as Record<string, unknown>;
    return { decrypted: true, payload };
  }
  return { decrypted: false, payload: body };
}

function requiresDevApiKey(url: string): boolean {
  const [path] = url.split("?");
  if (path.startsWith("/dev")) {
    return true;
  }

  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length === 3 && segments[0] === "kb" && segments[2] === "ask";
}

function getSecurityMode(config: AppConfig): "dry-run" | "card-real" | "fully-real" {
  if (
    !config.feishuDryRun &&
    !config.feishuCardSendDryRun &&
    !config.feishuTaskCreateDryRun &&
    !config.feishuCalendarCreateDryRun &&
    !config.feishuKnowledgeWriteDryRun
  ) {
    return "fully-real";
  }

  return config.feishuCardSendDryRun ? "dry-run" : "card-real";
}

function logSecurityMode(app: FastifyInstance, config: AppConfig) {
  const missingConfig = [
    config.devApiKey ? null : "DEV_API_KEY",
    config.larkVerificationToken ? null : "LARK_VERIFICATION_TOKEN",
    config.larkEncryptKey ? null : "LARK_ENCRYPT_KEY"
  ].filter((name): name is string => name !== null);

  app.log.info(
    {
      node_env: config.nodeEnv,
      security_mode: getSecurityMode(config),
      dry_run: config.feishuDryRun,
      card_send_dry_run: config.feishuCardSendDryRun,
      task_create_dry_run: config.feishuTaskCreateDryRun,
      calendar_create_dry_run: config.feishuCalendarCreateDryRun,
      knowledge_write_dry_run: config.feishuKnowledgeWriteDryRun,
      event_card_chat_configured: Boolean(config.feishuEventCardChatId)
    },
    "meetingatlas security mode"
  );

  if (missingConfig.length > 0) {
    app.log.warn(
      {
        node_env: config.nodeEnv,
        missing_config: missingConfig,
        local_bypass_enabled: allowsLocalSecurityBypass(config)
      },
      "meetingatlas security configuration missing"
    );
  }
}

function getFeishuEventType(payload: FeishuEventWebhookPayload): string | null {
  if (typeof payload.event_type === "string") {
    return payload.event_type;
  }

  return typeof payload.header?.event_type === "string" ? payload.header.event_type : null;
}

function getFeishuEventId(payload: FeishuEventWebhookPayload): string | null {
  return firstString([
    valueAtPath(payload, ["header", "event_id"]),
    valueAtPath(payload, ["event", "event_id"]),
    payload.event_id
  ]);
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

function confirmationPayload(request: ConfirmationRequestRow): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(request.original_payload_json) as unknown) ?? {};
  } catch {
    return {};
  }
}

function topicKeyFromConfirmation(request: ConfirmationRequestRow): string | null {
  const payload = confirmationPayload(request);
  const topicMatch = asRecord(payload.topic_match);
  return firstString([
    payload.topic_key,
    payload.topic,
    payload.topic_name,
    payload.kb_name,
    topicMatch?.topic,
    topicMatch?.matched_kb_name
  ]);
}

function createSourceFromArchiveAction(input: {
  repos: Repositories;
  config: AppConfig;
  confirmation: ConfirmationRequestRow;
  archiveStatus: "confirmed" | "skipped";
}) {
  const payload = confirmationPayload(input.confirmation);
  const source = asRecord(payload.source) ?? {};
  const title = firstString([source.title, payload.title]) ?? "外部资料";
  const sourceType = firstString([source.source_type, payload.source_type]) ?? "external";
  const sourceUrl = firstString([source.url, payload.url, payload.source_url]);
  const reason = firstString([source.reason, payload.reason]);
  const evidence = firstString([source.evidence, payload.evidence]);
  const kbId = firstString([source.kb_id, payload.kb_id]);
  const meetingId = firstString([payload.meeting_id, source.meeting_id]);

  const sourceId = createId("source");
  const row = input.repos.createSource({
    id: sourceId,
    kb_id: kbId,
    meeting_id: meetingId,
    source_type: sourceType,
    title,
    url: sourceUrl,
    source_url: sourceUrl,
    summary: evidence,
    why_related: reason,
    archive_section: input.archiveStatus === "confirmed" ? "resources" : null,
    archive_status: input.archiveStatus,
    confirmation_status: input.archiveStatus,
    permission_status: "visible",
    added_from:
      firstString([payload.meeting_reference, payload.meeting_title, meetingId]) ??
      input.confirmation.target_id
  } as Parameters<Repositories["createSource"]>[0] & {
    archive_status: "confirmed" | "skipped";
    meeting_id: string | null;
    url: string | null;
  });

  if (input.config.sqlitePath !== ":memory:") {
    const db = createDatabase(input.config.sqlitePath) as ReturnType<typeof createDatabase> & {
      close?: () => void;
    };
    try {
      db.prepare("UPDATE sources SET meeting_id = ?, url = ?, archive_status = ? WHERE id = ?").run(
        meetingId,
        sourceUrl,
        input.archiveStatus,
        sourceId
      );
    } finally {
      db.close?.();
    }
  }

  return row;
}

function applySourceArchiveAction(input: {
  repos: Repositories;
  config: AppConfig;
  confirmation: ConfirmationRequestRow;
  archiveStatus: "confirmed" | "skipped";
}): ConfirmationRequestRow {
  createSourceFromArchiveAction(input);
  const now = nowIso();
  input.repos.updateConfirmationRequest({
    id: input.confirmation.id,
    status: input.archiveStatus === "confirmed" ? "executed" : "rejected",
    confirmed_at: input.archiveStatus === "confirmed" ? now : null,
    executed_at: input.archiveStatus === "confirmed" ? now : null,
    error: input.archiveStatus === "confirmed" ? null : "skip_archive"
  });

  return input.repos.getConfirmationRequest(input.confirmation.id) ?? input.confirmation;
}

const CONFIRM_CARD_ACTION_KEYS = new Set([
  "confirm",
  "confirm_with_edits",
  "create_kb",
  "edit_and_create",
  "complete_owner"
]);
const REJECT_CARD_ACTION_KEYS = new Set(["reject", "not_mine", "never_remind_topic"]);
const SOURCE_ARCHIVE_CARD_ACTION_KEYS = new Set(["confirm_archive", "skip_archive"]);
const STATEFUL_CARD_ACTIONS = {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTranscriptForMeetingEvent(input: {
  repos: Repositories;
  config: AppConfig;
  eventType: string;
  externalMeetingId: string;
  title: string;
  minuteToken: string | null;
  runner?: LarkCliRunner;
  log: FastifyRequest["log"];
}): Promise<{
  transcript: string;
  attempts: number;
  pending: boolean;
  error: string | null;
}> {
  const isMeetingEnded = input.eventType === FeishuMeetingEndedEventType;
  const retryDelays = isMeetingEnded
    ? input.config.nodeEnv === "test"
      ? TestMeetingEndedTranscriptRetryDelaysMs
      : MeetingEndedTranscriptRetryDelaysMs
    : ([RecordingReadyTranscriptWaitMs] as const);
  const timeoutMs = isMeetingEnded
    ? MeetingEndedTranscriptFetchTimeoutMs
    : RecordingReadyTranscriptFetchTimeoutMs;
  let lastError: string | null = null;

  for (let index = 0; index < retryDelays.length; index += 1) {
    const waitMs = retryDelays[index] ?? 0;
    await delay(waitMs);

    try {
      const transcript = await withTimeout(
        fetchTranscript({
          repos: input.repos,
          config: input.config,
          meetingId: input.externalMeetingId,
          title: input.title,
          minuteToken: input.minuteToken,
          runner: input.runner
        }),
        timeoutMs,
        TranscriptPendingText
      );

      if (transcript !== TranscriptPendingText) {
        return {
          transcript,
          attempts: index + 1,
          pending: false,
          error: null
        };
      }

      lastError = "transcript_fetch_timeout";
      input.log.warn(
        {
          event_type: input.eventType,
          external_meeting_id: input.externalMeetingId,
          attempt: index + 1,
          attempts: retryDelays.length,
          timeout_ms: timeoutMs
        },
        "transcript fetch timed out for feishu meeting event"
      );
    } catch (error) {
      lastError = briefError(error);
      input.log.warn(
        {
          err: error,
          event_type: input.eventType,
          external_meeting_id: input.externalMeetingId,
          attempt: index + 1,
          attempts: retryDelays.length
        },
        "failed to fetch transcript for feishu meeting event"
      );
    }

    if (!isMeetingEnded) {
      return {
        transcript: TranscriptPendingText,
        attempts: index + 1,
        pending: true,
        error: lastError
      };
    }
  }

  return {
    transcript: TranscriptPendingText,
    attempts: retryDelays.length,
    pending: true,
    error: lastError
  };
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
  statusText?: string;
  runner?: LarkCliRunner;
}) {
  const latest = input.repos.getConfirmationRequest(input.request.id) ?? input.request;
  const card = buildConfirmationCardFromRequest(latest, { repos: input.repos });
  if (input.statusText !== undefined) {
    card.status_text = input.statusText;
  }

  return syncConfirmationCardStatus({
    repos: input.repos,
    config: input.config,
    confirmation: latest,
    card,
    updateToken: input.updateToken,
    messageId: input.messageId,
    chatId: input.chatId,
    runner: input.runner
  });
}

async function syncDevTerminalCardStatus(input: {
  log: FastifyRequest["log"];
  repos: Repositories;
  config: AppConfig;
  request: ConfirmationRequestRow;
  runner?: LarkCliRunner;
}) {
  if (!input.request.card_message_id) {
    return {
      ok: true,
      skipped: true,
      method: "skipped",
      status: "skipped",
      dry_run: input.config.feishuCardSendDryRun,
      update_cli_run_id: null,
      fallback_cli_run_id: null,
      card_message_id: null,
      recipient: input.request.recipient,
      chat_id: null,
      error: null
    };
  }

  try {
    const result = await syncCardStatusForRequest({
      repos: input.repos,
      config: input.config,
      request: input.request,
      messageId: input.request.card_message_id,
      statusText: input.request.status === "rejected" ? "已拒绝" : undefined,
      runner: input.runner
    });

    if (!result.ok) {
      input.log.warn(
        cardStatusLogContext({
          confirmationId: input.request.id,
          phase: "dev_terminal",
          result
        }),
        "dev confirmation card status update failed"
      );
    }

    return {
      ...result,
      skipped: false
    };
  } catch (error) {
    input.log.warn(
      { err: error, confirmation_id: input.request.id },
      "dev confirmation card status update threw after terminal transition"
    );
    return {
      ok: false,
      skipped: false,
      method: "error",
      status: "failed",
      dry_run: input.config.feishuCardSendDryRun,
      update_cli_run_id: null,
      fallback_cli_run_id: null,
      card_message_id: input.request.card_message_id,
      recipient: input.request.recipient,
      chat_id: null,
      error: briefError(error)
    };
  }
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
  forceChatDestination?: boolean;
}): { recipient: string | null; chatId: string | null } {
  const chatId = stringValue(input.sendToChatId);
  if (input.forceChatDestination && chatId !== null) {
    return {
      recipient: null,
      chatId
    };
  }

  if (PERSONAL_KNOWLEDGE_REQUEST_TYPES.has(input.confirmation.request_type)) {
    return {
      recipient: input.confirmation.recipient,
      chatId: null
    };
  }

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
  forceChatDestination?: boolean;
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
      sendToChatId: input.sendToChatId,
      forceChatDestination: input.forceChatDestination
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

function scheduleSnoozedReminder(input: {
  repos: Repositories;
  config: AppConfig;
  confirmationId: string;
  snoozeUntil: string;
  chatId?: string | null;
  runner?: LarkCliRunner;
  log?: FastifyRequest["log"];
}) {
  const delayMs = Math.max(0, new Date(input.snoozeUntil).getTime() - Date.now());
  const timer = setTimeout(() => {
    void (async () => {
      const latest = input.repos.getConfirmationRequest(input.confirmationId);
      if (
        latest === null ||
        latest.status !== "snoozed" ||
        latest.snooze_until !== input.snoozeUntil
      ) {
        return;
      }

      input.repos.updateConfirmationRequest({
        id: latest.id,
        status: "sent",
        error: null
      });
      const reminder = input.repos.getConfirmationRequest(latest.id) ?? {
        ...latest,
        status: "sent" as const
      };
      const destination = automaticCardDestination({
        confirmation: reminder,
        sendToChatId: input.chatId
      });
      const result = await sendCard({
        repos: input.repos,
        config: input.config,
        confirmation: reminder,
        card: buildConfirmationCardFromRequest(reminder),
        recipient: destination.recipient,
        chatId: destination.chatId,
        runner: input.runner
      });
      if (!result.ok) {
        input.log?.warn(
          {
            confirmation_id: reminder.id,
            error: result.error
          },
          "failed to resend snoozed confirmation card"
        );
      }
    })().catch((error) => {
      input.log?.error(
        { err: error, confirmation_id: input.confirmationId },
        "snoozed reminder timer failed"
      );
    });
  }, delayMs);
  timer.unref();
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
  logSecurityMode(app, input.config);

  app.addHook("onRequest", async (request, reply) => {
    if (!requiresDevApiKey(request.url)) {
      return;
    }

    const devApiKey = input.config.devApiKey;
    if (!devApiKey) {
      if (allowsLocalSecurityBypass(input.config)) {
        request.log.warn(
          { path: request.url },
          "DEV_API_KEY not configured; allowing protected request in local environment"
        );
        return;
      }

      return reply.code(503).send({ error: "DEV_API_KEY not configured" });
    }

    if (request.headers["x-dev-api-key"] !== devApiKey) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => {
    const cardCallbackReadiness = getCardCallbackReadiness(input.config);
    const feishuWebhookReadiness = getFeishuWebhookReadiness(input.config);
    return {
      ok: true,
      service: "meeting-atlas",
      phase: "phase-6",
      dry_run: input.config.feishuDryRun,
      read_dry_run: input.config.feishuReadDryRun,
      card_send_dry_run: input.config.feishuCardSendDryRun,
      card_actions_enabled: input.config.feishuCardActionsEnabled,
      card_callback_ready: cardCallbackReadiness.ready,
      card_callback_url_configured: cardCallbackReadiness.callback_url_configured,
      feishu_webhook_ready: feishuWebhookReadiness.ready,
      feishu_webhook_encrypt_key_configured: feishuWebhookReadiness.encrypt_key_configured,
      feishu_webhook_verification_token_configured:
        feishuWebhookReadiness.verification_token_configured,
      feishu_event_card_chat_configured: feishuWebhookReadiness.event_card_chat_configured,
      task_create_dry_run: input.config.feishuTaskCreateDryRun,
      calendar_create_dry_run: input.config.feishuCalendarCreateDryRun,
      knowledge_write_dry_run: input.config.feishuKnowledgeWriteDryRun,
      llm_provider: input.config.llmProvider,
      sqlite_path: input.config.sqlitePath
    };
  });

  app.post("/kb/:kbId/ask", async (request, reply) => {
    const { kbId } = request.params as { kbId: string };
    const { question } = KnowledgeBaseAskBodySchema.parse(request.body);
    const result = await runQaAgent({
      repos: input.repos,
      kbId,
      question,
      llm: input.llm
    });
    return reply.send(result);
  });

  app.post("/webhooks/feishu/event", async (request, reply) => {
    const rawBody = getRawBody(request);
    const rawPayload = (request.body ?? {}) as Record<string, unknown>;

    // Handle unencrypted challenge (no Encrypt Key configured)
    if (typeof rawPayload.challenge === "string") {
      return { challenge: rawPayload.challenge };
    }

    // Handle encrypted payload (Encrypt Key configured in Feishu Open Platform)
    const { decrypted, payload: payloadData } = decryptFeishuPayloadIfEncrypted(
      rawPayload,
      input.config.larkEncryptKey
    );
    const payload = payloadData as FeishuEventWebhookPayload;

    // Handle encrypted challenge (return immediately, no signature check needed)
    if (decrypted && typeof payload.challenge === "string") {
      return { challenge: payload.challenge };
    }

    if (!input.config.larkVerificationToken) {
      if (allowsLocalSecurityBypass(input.config)) {
        request.log.warn(
          "LARK_VERIFICATION_TOKEN not configured; allowing event webhook request in local environment"
        );
      } else {
        return reply.code(503).send({ error: "LARK_VERIFICATION_TOKEN not configured" });
      }
    }

    if (
      !allowsUnsignedLocalWebhook(input.config) &&
      !isLarkSignatureValid({
        request,
        body: rawBody,
        verificationToken: input.config.larkVerificationToken,
        encryptKey: input.config.larkEncryptKey
      })
    ) {
      request.log.warn(
        {
          ...getLarkSignatureDiagnostics(request),
          decrypted
        },
        "rejected feishu event webhook with invalid signature"
      );
      return reply.code(401).send({ error: "Invalid Lark webhook signature" });
    }

    if (
      !hasValidVerificationToken({
        payload: payloadData,
        verificationToken: input.config.larkVerificationToken
      })
    ) {
      request.log.warn(
        {
          event_type: getFeishuEventType(payload),
          has_token: verificationTokenInPayload(payloadData) !== null
        },
        "rejected feishu event webhook with invalid verification token"
      );
      return reply.code(401).send({ error: "Invalid Lark verification token" });
    }

    const eventType = getFeishuEventType(payload);
    request.log.info({ event_type: eventType }, "received feishu event webhook");

    if (eventType === FeishuRecordingReadyEventType || eventType === FeishuMeetingEndedEventType) {
      const event = FeishuRecordingReadyEventSchema.parse(payload.event ?? {});
      const eventRecord = asRecord(event) ?? {};
      const meetingRecord = firstRecord([
        asRecord(eventRecord.meeting),
        asRecord(eventRecord.video_meeting),
        asRecord(eventRecord.video_conference),
        asRecord(eventRecord.recording)
      ]);
      const organizer =
        firstString([
          valueAtPath(event, ["operator_id", "open_id"]),
          valueAtPath(event, ["host_user_id", "open_id"]),
          valueAtPath(event, ["host", "open_id"]),
          valueAtPath(event, ["owner", "open_id"]),
          valueAtPath(meetingRecord, ["host_user_id", "open_id"]),
          valueAtPath(meetingRecord, ["owner", "open_id"])
        ]) ?? null;
      const minuteToken =
        firstString([
          event.minute_token,
          eventRecord.minute_token,
          meetingRecord.minute_token,
          meetingRecord.minutes_token,
          valueAtPath(event, ["recording", "minute_token"])
        ]) ?? null;
      const externalMeetingRef = firstString([
        event.meeting_id,
        eventRecord.meeting_id,
        meetingRecord.meeting_id,
        meetingRecord.id,
        minuteToken
      ]);
      const externalMeetingId = externalMeetingRef ?? "unknown";
      const title =
        firstString([
          event.topic,
          eventRecord.topic,
          eventRecord.title,
          eventRecord.name,
          meetingRecord.topic,
          meetingRecord.title,
          meetingRecord.name
        ]) ?? externalMeetingId;
      const minutesUrl =
        firstString([
          eventRecord.minutes_url,
          eventRecord.minute_url,
          eventRecord.meeting_url,
          eventRecord.url,
          meetingRecord.minutes_url,
          meetingRecord.minute_url,
          meetingRecord.url,
          valueAtPath(event, ["recording", "url"])
        ]) ?? null;
      const webhookEventId =
        getFeishuEventId(payload) ??
        (eventType !== null && externalMeetingRef !== null
          ? `${eventType}:${externalMeetingRef}`
          : null);

      if (webhookEventId === null) {
        request.log.warn(
          { event_type: eventType, external_meeting_id: externalMeetingRef },
          "accepted feishu event webhook without durable idempotency key"
        );
        return reply
          .code(202)
          .send({ accepted: true, ignored: true, reason: "missing_event_id" });
      }

      const webhookEvent = input.repos.registerWebhookEvent({
        id: createId("webhook_event"),
        event_id: webhookEventId,
        event_type: eventType,
        external_ref: externalMeetingRef
      });
      if (!webhookEvent.accepted) {
        request.log.info(
          {
            event_type: eventType,
            event_id: webhookEventId,
            external_meeting_id: externalMeetingRef,
            status: webhookEvent.event.status
          },
          "accepted duplicate feishu event webhook"
        );
        return reply.code(202).send({ accepted: true, duplicate: true });
      }

      void (async () => {
        const transcriptResult = await fetchTranscriptForMeetingEvent({
          repos: input.repos,
          config: input.config,
          eventType,
          externalMeetingId,
          title,
          minuteToken,
          runner: input.larkCliRunner,
          log: request.log
        });

        if (eventType === FeishuMeetingEndedEventType && transcriptResult.pending) {
          input.repos.updateWebhookEventStatus({
            event_id: webhookEventId,
            status: "failed",
            error: `pending_transcript_after_retries: ${
              transcriptResult.error ?? "transcript unavailable"
            }`.slice(0, 500)
          });
          request.log.warn(
            {
              event_type: eventType,
              event_id: webhookEventId,
              external_meeting_id: externalMeetingId,
              attempts: transcriptResult.attempts,
              error: transcriptResult.error
            },
            "deferred meeting-ended event until transcript is ready"
          );
          return;
        }

        const transcript = transcriptResult.transcript;
        if (transcriptResult.pending) {
          request.log.warn(
            {
              event_type: eventType,
              event_id: webhookEventId,
              external_meeting_id: externalMeetingId,
              attempts: transcriptResult.attempts,
              error: transcriptResult.error
            },
            "using fallback transcript for recording-ready event"
          );
        }

        const result = await processMeetingWorkflow({
          repos: input.repos,
          llm: input.llm,
          sourceRetrievalEnabled: input.config.llmProvider !== "mock",
          meeting: {
            external_meeting_id: externalMeetingId,
            title,
            participants: organizer === null ? [] : [organizer],
            organizer,
            started_at: null,
            ended_at: null,
            minutes_url: minutesUrl,
            transcript_text: transcript
          }
        });
        const cardSendResults = await sendGeneratedConfirmationCards({
          repos: input.repos,
          config: input.config,
          confirmationIds: result.confirmation_requests,
          sendToChatId: input.config.feishuEventCardChatId,
          forceChatDestination: Boolean(input.config.feishuEventCardChatId),
          runner: input.larkCliRunner
        });
        const skippedCardSends = result.confirmation_requests.length - cardSendResults.length;

        request.log.info(
          {
            event_type: eventType,
            event_id: webhookEventId,
            external_meeting_id: externalMeetingId,
            meeting_id: result.meeting_id,
            confirmation_requests: result.confirmation_requests.length,
            card_send_results: cardSendResults.length,
            card_send_skipped: skippedCardSends,
            card_send_failed: cardSendResults.filter((item) => !item.ok).length,
            card_send_dry_run: input.config.feishuCardSendDryRun,
            event_card_chat_configured: Boolean(input.config.feishuEventCardChatId),
            transcript_preview: transcript.slice(0, 80)
          },
          "triggered meeting workflow from feishu event"
        );
        if (skippedCardSends > 0 || cardSendResults.some((item) => !item.ok)) {
          request.log.warn(
            {
              event_type: eventType,
              external_meeting_id: externalMeetingId,
              skipped_card_sends: skippedCardSends,
              failed_card_sends: cardSendResults
                .filter((item) => !item.ok)
                .map((item) => ({
                  recipient: item.recipient,
                  chat_id: item.chat_id,
                  error: item.error
                }))
            },
            "some generated confirmation cards were not delivered"
          );
        }
        input.repos.updateWebhookEventStatus({
          event_id: webhookEventId,
          status: "processed",
          error: null
        });
      })().catch((error) => {
        input.repos.updateWebhookEventStatus({
          event_id: webhookEventId,
          status: "failed",
          error: briefError(error).slice(0, 500)
        });
        request.log.error(
          {
            event_type: eventType,
            event_id: webhookEventId,
            external_meeting_id: externalMeetingId,
            err: error
          },
          "failed meeting workflow from feishu event"
        );
      });

      return reply.code(202).send({ accepted: true });
    }

    request.log.info({ event_type: eventType }, "accepted unsupported feishu event webhook");
    return reply.code(202).send({ accepted: true });
  });

  app.post("/webhooks/feishu/card-action", async (request, reply) => {
    const rawBody = getRawBody(request);
    const rawBodyRecord = asRecord(request.body ?? {});

    // Handle unencrypted challenge (no Encrypt Key configured)
    if (rawBodyRecord !== null && typeof rawBodyRecord.challenge === "string") {
      return { challenge: rawBodyRecord.challenge };
    }

    // Handle encrypted payload (Encrypt Key configured in Feishu Open Platform)
    const { decrypted, payload: decryptedPayload } = decryptFeishuPayloadIfEncrypted(
      rawBodyRecord ?? {},
      input.config.larkEncryptKey
    );
    const bodyRecord = decrypted ? (decryptedPayload as Record<string, unknown>) : rawBodyRecord;

    // Handle encrypted challenge (return immediately, no signature check needed)
    if (decrypted && bodyRecord !== null && typeof bodyRecord.challenge === "string") {
      return { challenge: bodyRecord.challenge };
    }

    if (!input.config.larkVerificationToken) {
      if (allowsLocalSecurityBypass(input.config)) {
        request.log.warn(
          "LARK_VERIFICATION_TOKEN not configured; allowing card-action request in local environment"
        );
      } else {
        return reply.code(503).send({ error: "LARK_VERIFICATION_TOKEN not configured" });
      }
    }

    if (
      !allowsUnsignedLocalWebhook(input.config) &&
      !isLarkCardActionSignatureValid({
        request,
        rawBody: rawBody,
        body: decrypted ? decryptedPayload : (request.body ?? {}),
        verificationToken: input.config.larkVerificationToken,
        encryptKey: input.config.larkEncryptKey
      })
    ) {
      request.log.warn(
        getLarkSignatureDiagnostics(request),
        "rejected feishu card action webhook with invalid signature"
      );
      return reply.code(401).send({ error: "Invalid Lark webhook signature" });
    }

    const parsed = extractCardCallbackPayload(decrypted ? decryptedPayload : (request.body ?? {}));

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
      if (SOURCE_ARCHIVE_CARD_ACTION_KEYS.has(parsed.actionKey)) {
        const archiveStatus = parsed.actionKey === "confirm_archive" ? "confirmed" : "skipped";
        const archived = applySourceArchiveAction({
          repos: input.repos,
          config: input.config,
          confirmation,
          archiveStatus
        });

        void syncCardStatusForRequest({
          repos: input.repos,
          config: input.config,
          request: archived,
          updateToken: parsed.updateToken,
          messageId: parsed.messageId,
          chatId: parsed.chatId,
          runner: input.larkCliRunner
        }).catch((error) => {
          request.log.error(
            { err: error, confirmation_id: requestId, action: parsed.actionKey },
            "failed to update source archival card status"
          );
        });

        return cardCallbackResponse({
          type: "success",
          content: archiveStatus === "confirmed" ? "已确认归档" : "已跳过归档",
          confirmation: archived
        });
      }

      if (CONFIRM_CARD_ACTION_KEYS.has(parsed.actionKey)) {
        try {
          const execution = await confirmRequest({
            repos: input.repos,
            config: input.config,
            id: requestId,
            editedPayload: parsed.editedPayload,
            actorOpenId: parsed.actorOpenId,
            allowPreconfirmed: true,
            runner: input.larkCliRunner
          });

          try {
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
          } catch (error) {
            request.log.warn(
              { err: error, confirmation_id: requestId },
              "card status update failed after execution"
            );
          }

          if (execution.confirmation.status === "failed") {
            return cardCallbackResponse({
              type: "error",
              content: `确认执行失败：${execution.confirmation.error ?? "unknown error"}`,
              confirmation: execution.confirmation
            });
          }

          return cardCallbackResponse({
            type: "success",
            content: CardActionConfirmedMessage,
            confirmation: execution.confirmation
          });
        } catch (error) {
          input.repos.updateConfirmationRequest({
            id: requestId,
            status: "failed",
            error: briefError(error)
          });
          const failed = input.repos.getConfirmationRequest(requestId) ?? confirmation;
          let finalUpdate: Awaited<ReturnType<typeof syncCardStatusForRequest>> | null = null;
          try {
            finalUpdate = await syncCardStatusForRequest({
              repos: input.repos,
              config: input.config,
              request: failed,
              updateToken: parsed.updateToken,
              messageId: parsed.messageId,
              chatId: parsed.chatId,
              runner: input.larkCliRunner
            });
          } catch (syncError) {
            request.log.warn(
              { err: syncError, confirmation_id: requestId },
              "card status update failed after confirm failure"
            );
          }
          request.log.error(
            {
              err: error,
              confirmation_id: requestId,
              card_status_method: finalUpdate?.method ?? null,
              card_status_ok: finalUpdate?.ok ?? false
            },
            "confirm failed"
          );
          return cardCallbackResponse({
            type: "error",
            content: `确认执行失败：${failed.error ?? briefError(error)}`,
            confirmation: failed
          });
        }
      }

      if (REJECT_CARD_ACTION_KEYS.has(parsed.actionKey)) {
        if (parsed.actionKey === "never_remind_topic") {
          const topicKey = topicKeyFromConfirmation(confirmation);
          const actorOpenId = parsed.actorOpenId ?? null;
          if (actorOpenId !== null && topicKey !== null) {
            input.repos.insertTopicSuppression({
              id: createId("topic_supp"),
              user_id: actorOpenId,
              topic_key: topicKey
            });
          }
        }

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

      const statefulAction =
        STATEFUL_CARD_ACTIONS[parsed.actionKey as keyof typeof STATEFUL_CARD_ACTIONS];
      if (statefulAction === "remind_later") {
        const result = snoozeConfirmation({
          repos: input.repos,
          id: requestId,
          minutes: RemindLaterDelayMinutes
        });
        input.repos.updateConfirmationRequest({
          id: requestId,
          status: "snoozed",
          error: null,
          snooze_until: result.snooze.snooze_until
        });
        const snoozedConfirmation = input.repos.getConfirmationRequest(requestId) ?? {
          ...result.confirmation,
          snooze_until: result.snooze.snooze_until
        };
        const snoozedCard = {
          ...buildConfirmationCardFromRequest(snoozedConfirmation),
          status_text: CardActionSnoozedMessage,
          actions: []
        };
        scheduleSnoozedReminder({
          repos: input.repos,
          config: input.config,
          confirmationId: requestId,
          snoozeUntil: result.snooze.snooze_until,
          chatId: parsed.chatId,
          runner: input.larkCliRunner,
          log: request.log
        });
        void syncConfirmationCardStatus({
          repos: input.repos,
          config: input.config,
          confirmation: snoozedConfirmation,
          card: snoozedCard,
          updateToken: parsed.updateToken,
          messageId: parsed.messageId,
          chatId: parsed.chatId,
          runner: input.larkCliRunner
        }).catch((error) => {
          request.log.error(
            { err: error, confirmation_id: requestId, action: parsed.actionKey },
            "failed to update snoozed card status"
          );
        });

        return {
          ...toast("success", CardActionSnoozedMessage),
          card: buildFeishuInteractiveCard(snoozedCard)
        };
      }

      if (statefulAction === "convert_to_task") {
        const result = await convertCalendarConfirmationToActionConfirmation({
          repos: input.repos,
          id: requestId,
          llm: input.llm
        });
        const actionCard = buildConfirmationCardFromRequest(result.confirmation);
        void syncConfirmationCardStatus({
          repos: input.repos,
          config: input.config,
          confirmation: result.confirmation,
          card: actionCard,
          updateToken: parsed.updateToken,
          messageId: parsed.messageId,
          chatId: parsed.chatId,
          runner: input.larkCliRunner
        }).catch((error) => {
          request.log.error(
            { err: error, confirmation_id: requestId, action: parsed.actionKey },
            "failed to update converted action card"
          );
        });

        return {
          ...toast("success", "已转成待办确认卡"),
          card: buildFeishuInteractiveCard(actionCard)
        };
      }

      if (statefulAction === "append_current_only") {
        const result = appendCurrentOnlyConfirmation({
          repos: input.repos,
          id: requestId
        });
        const appendCard = buildConfirmationCardFromRequest(result.confirmation);
        void syncConfirmationCardStatus({
          repos: input.repos,
          config: input.config,
          confirmation: result.confirmation,
          card: appendCard,
          updateToken: parsed.updateToken,
          messageId: parsed.messageId,
          chatId: parsed.chatId,
          runner: input.larkCliRunner
        }).catch((error) => {
          request.log.error(
            { err: error, confirmation_id: requestId, action: parsed.actionKey },
            "failed to update append-current-only card"
          );
        });

        return {
          ...toast("success", "已转为仅归档当前会议确认"),
          card: buildFeishuInteractiveCard(appendCard)
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
      sourceRetrievalEnabled: input.config.llmProvider !== "mock",
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
      sourceRetrievalEnabled: input.config.llmProvider !== "mock",
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
    const result = await confirmRequest({
      repos: input.repos,
      config: input.config,
      id: params.id,
      editedPayload: body.edited_payload,
      runner: input.larkCliRunner
    });
    const cardUpdate = await syncDevTerminalCardStatus({
      log: request.log,
      repos: input.repos,
      config: input.config,
      request: result.confirmation,
      runner: input.larkCliRunner
    });

    return {
      ...result,
      card_update: cardUpdate
    };
  });

  app.post("/dev/confirmations/:id/reject", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string | null };
    const confirmation = rejectRequest({
      repos: input.repos,
      id: params.id,
      reason: body.reason
    });
    const cardUpdate = await syncDevTerminalCardStatus({
      log: request.log,
      repos: input.repos,
      config: input.config,
      request: confirmation,
      runner: input.larkCliRunner
    });

    return {
      confirmation,
      card_update: cardUpdate
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
    try {
      const result = snoozeConfirmation({
        repos: input.repos,
        id: params.id,
        minutes: RemindLaterDelayMinutes
      });
      input.repos.updateConfirmationRequest({
        id: params.id,
        status: "snoozed",
        error: null,
        snooze_until: result.snooze.snooze_until
      });
      const snoozedConfirmation = input.repos.getConfirmationRequest(params.id) ?? {
        ...result.confirmation,
        snooze_until: result.snooze.snooze_until
      };
      scheduleSnoozedReminder({
        repos: input.repos,
        config: input.config,
        confirmationId: params.id,
        snoozeUntil: result.snooze.snooze_until,
        runner: input.larkCliRunner,
        log: request.log
      });
      return {
        ok: true,
        dry_run: true,
        action: "remind_later",
        message: CardActionSnoozedMessage,
        confirmation: snoozedConfirmation,
        snooze: result.snooze,
        dry_run_card: {
          ...buildConfirmationCardFromRequest(snoozedConfirmation),
          status_text: CardActionSnoozedMessage,
          actions: []
        }
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("Confirmation request not found")) {
        return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
      }

      throw error;
    }
  });

  app.post("/dev/confirmations/:id/convert-to-task", async (request, reply) => {
    const params = request.params as { id: string };
    try {
      const result = await convertCalendarConfirmationToActionConfirmation({
        repos: input.repos,
        id: params.id,
        llm: input.llm
      });
      return {
        ok: true,
        dry_run: true,
        action: "convert_to_task",
        source_confirmation: result.source_confirmation,
        action_item_id: result.action_item_id,
        confirmation: result.confirmation,
        dry_run_card: buildConfirmationCardFromRequest(result.confirmation)
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("Confirmation request not found")) {
        return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
      }

      throw error;
    }
  });

  app.post("/dev/confirmations/:id/append-current-only", async (request, reply) => {
    const params = request.params as { id: string };
    try {
      const result = appendCurrentOnlyConfirmation({
        repos: input.repos,
        id: params.id
      });
      return {
        ok: true,
        dry_run: true,
        action: "append_current_only",
        source_confirmation: result.source_confirmation,
        knowledge_base_id: result.knowledge_base_id,
        meeting_id: result.meeting_id,
        confirmation: result.confirmation,
        dry_run_card: buildConfirmationCardFromRequest(result.confirmation)
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("Confirmation request not found")) {
        return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
      }

      throw error;
    }
  });

  app.post("/dev/confirmations/:id/confirm-archive", async (request, reply) => {
    const params = request.params as { id: string };
    const confirmation = input.repos.getConfirmationRequest(params.id);
    if (confirmation === null) {
      return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
    }

    const archived = applySourceArchiveAction({
      repos: input.repos,
      config: input.config,
      confirmation,
      archiveStatus: "confirmed"
    });

    return {
      ok: true,
      dry_run: true,
      action: "confirm_archive",
      confirmation: archived,
      dry_run_card: buildConfirmationCardFromRequest(archived)
    };
  });

  app.post("/dev/confirmations/:id/skip-archive", async (request, reply) => {
    const params = request.params as { id: string };
    const confirmation = input.repos.getConfirmationRequest(params.id);
    if (confirmation === null) {
      return reply.code(404).send({ error: `Confirmation request not found: ${params.id}` });
    }

    const archived = applySourceArchiveAction({
      repos: input.repos,
      config: input.config,
      confirmation,
      archiveStatus: "skipped"
    });

    return {
      ok: true,
      dry_run: true,
      action: "skip_archive",
      confirmation: archived,
      dry_run_card: buildConfirmationCardFromRequest(archived)
    };
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
