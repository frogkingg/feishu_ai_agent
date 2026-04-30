import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { AppConfig } from "./config";
import { ManualMeetingInputSchema } from "./schemas";
import { buildConfirmationCardFromRequest } from "./agents/cardInteractionAgent";
import { runMeetingExtractionAgent } from "./agents/meetingExtractionAgent";
import { confirmRequest, rejectRequest } from "./services/confirmationService";
import { LlmClient } from "./services/llm/llmClient";
import { MeetingRow, Repositories } from "./services/store/repositories";
import { sendCard } from "./tools/larkIm";
import { type LarkCliRunner } from "./tools/larkCli";
import { fetchTranscript } from "./tools/larkVc";
import { nowIso } from "./utils/dates";
import { verifyLarkWebhookSignature } from "./utils/larkSignature";
import { processMeetingWorkflow } from "./workflows/processMeetingWorkflow";

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

const FeishuTranscriptionUpdatedEventType = "vc.meeting.transcription_updated";
const TranscriptPendingText =
  "【transcript pending - to be fetched via lark-cli vc transcript get】";
const CardActionPendingMessage = "此操作暂未实现，将在 PR-2 中完成";
const TranscriptFetchTimeoutMs = 3000;

const FeishuTranscriptionUpdatedEventSchema = z
  .object({
    meeting_id: z.string().trim().min(1),
    topic: z.string().trim().min(1).optional().nullable(),
    operator_id: z
      .object({
        open_id: z.string().trim().min(1).optional().nullable()
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

function getFeishuEventType(payload: FeishuEventWebhookPayload): string | null {
  if (typeof payload.event_type === "string") {
    return payload.event_type;
  }

  return typeof payload.header?.event_type === "string" ? payload.header.event_type : null;
}

function toast(type: "success" | "error", content: string) {
  return {
    toast: {
      type,
      content
    }
  };
}

const CONFIRM_CARD_ACTION_KEYS = new Set([
  "confirm",
  "confirm_with_edits",
  "create_kb",
  "edit_and_create"
]);
const REJECT_CARD_ACTION_KEYS = new Set(["reject", "not_mine", "never_remind_topic"]);
const PREVIEW_STUB_CARD_ACTIONS = {
  remind_later: "remind_later",
  convert_to_task: "convert_to_task",
  append_current_only: "append_current_only"
} as const;

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

function extractCardCallbackPayload(payload: unknown): {
  requestId: string | null;
  actionKey: string | null;
  editedPayload?: unknown;
  reason?: string | null;
} {
  const root = asRecord(payload) ?? {};
  const actionValue = firstRecord([
    recordAtPath(payload, ["event", "action", "value"]),
    recordAtPath(payload, ["action", "value"]),
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
  const editedPayload =
    valueFromActionPayload(actionValue, "edited_payload") ??
    recordAtPath(payload, ["event", "action", "form_value"]) ??
    recordAtPath(payload, ["event", "form_value"]);
  const reasonValue = valueFromActionPayload(actionValue, "reason");
  const reason = stringValue(reasonValue);

  return {
    requestId,
    actionKey,
    editedPayload,
    reason
  };
}

function cardCallbackPreview(parsed: ReturnType<typeof extractCardCallbackPayload>) {
  return {
    request_id: parsed.requestId,
    action_key: parsed.actionKey,
    has_edited_payload: parsed.editedPayload !== undefined && parsed.editedPayload !== null
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
    message: "This card action is preview-only in the current phase."
  };
}

function sendCardStatusCode(result: { ok: boolean; error: string | null }): number {
  if (result.ok) {
    return 200;
  }

  return result.error?.includes("requires recipient or chat_id") ? 400 : 502;
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
    card_send_dry_run: input.config.feishuCardSendDryRun,
    llm_provider: input.config.llmProvider,
    sqlite_path: input.config.sqlitePath
  }));

  app.post("/webhooks/feishu/event", async (request, reply) => {
    const rawBody = getRawBody(request);
    if (
      !isLarkSignatureValid({
        request,
        body: rawBody,
        verificationToken: input.config.larkVerificationToken
      })
    ) {
      request.log.warn("rejected feishu event webhook with invalid signature");
      return reply.code(401).send({ error: "Invalid Lark webhook signature" });
    }

    const payload = (request.body ?? {}) as FeishuEventWebhookPayload;
    const eventType = getFeishuEventType(payload);
    request.log.info({ event_type: eventType }, "received feishu event webhook");

    if (typeof payload.challenge === "string") {
      return { challenge: payload.challenge };
    }

    if (eventType === FeishuTranscriptionUpdatedEventType) {
      const event = FeishuTranscriptionUpdatedEventSchema.parse(payload.event ?? {});
      const organizer = event.operator_id?.open_id ?? null;
      const title = event.topic?.trim() || event.meeting_id;
      const transcript = await withTimeout(
        fetchTranscript({
          repos: input.repos,
          config: input.config,
          meetingId: event.meeting_id,
          runner: input.larkCliRunner
        }).catch((error) => {
          request.log.warn(
            { err: error, external_meeting_id: event.meeting_id },
            "failed to fetch transcript for feishu event; using fallback text"
          );
          return TranscriptPendingText;
        }),
        TranscriptFetchTimeoutMs,
        TranscriptPendingText
      );

      void processMeetingWorkflow({
        repos: input.repos,
        llm: input.llm,
        meeting: {
          external_meeting_id: event.meeting_id,
          title,
          participants: organizer === null ? [] : [organizer],
          organizer,
          started_at: null,
          ended_at: null,
          transcript_text: transcript
        }
      })
        .then((result) => {
          request.log.info(
            {
              event_type: eventType,
              external_meeting_id: event.meeting_id,
              meeting_id: result.meeting_id,
              confirmation_requests: result.confirmation_requests.length,
              transcript_preview: transcript.slice(0, 80)
            },
            "triggered meeting workflow from feishu transcription event"
          );
        })
        .catch((error) => {
          request.log.error(
            {
              event_type: eventType,
              external_meeting_id: event.meeting_id,
              err: error
            },
            "failed meeting workflow from feishu transcription event"
          );
        });

      return reply.code(202).send({ accepted: true });
    }

    request.log.info({ event_type: eventType }, "accepted unsupported feishu event webhook");
    return reply.code(202).send({ accepted: true });
  });

  app.post("/webhooks/feishu/card", async (request, reply) => {
    const payload = request.body ?? {};
    const root = asRecord(payload) ?? {};
    const challenge = stringValue(root.challenge);
    if (challenge !== null) {
      return { challenge };
    }

    if (!input.config.feishuDryRun) {
      return reply.code(409).send({
        ok: false,
        dry_run: false,
        error: "Feishu card callback skeleton only runs when FEISHU_DRY_RUN=true"
      });
    }

    const parsed = extractCardCallbackPayload(payload);
    const normalizedPreview = cardCallbackPreview(parsed);
    request.log.info({ normalized_preview: normalizedPreview }, "received feishu card callback");

    if (parsed.requestId === null || parsed.actionKey === null) {
      return reply.code(202).send({
        accepted: true,
        callback: "feishu.card",
        dry_run: true,
        normalized_preview: normalizedPreview,
        message: "Feishu card callback accepted without actionable request_id/action_key"
      });
    }

    const existing = input.repos.getConfirmationRequest(parsed.requestId);
    if (existing === null) {
      return reply
        .code(404)
        .send({ ok: false, error: `Confirmation request not found: ${parsed.requestId}` });
    }

    try {
      if (CONFIRM_CARD_ACTION_KEYS.has(parsed.actionKey)) {
        const result = await confirmRequest({
          repos: input.repos,
          config: input.config,
          id: parsed.requestId,
          editedPayload: parsed.editedPayload,
          runner: input.larkCliRunner
        });

        return {
          ok: result.confirmation.status !== "failed",
          dry_run: true,
          callback: "feishu.card",
          action_key: parsed.actionKey,
          request_id: parsed.requestId,
          handled_as: "confirm",
          confirmation: result.confirmation,
          result: result.result
        };
      }

      if (REJECT_CARD_ACTION_KEYS.has(parsed.actionKey)) {
        const confirmation = rejectRequest({
          repos: input.repos,
          id: parsed.requestId,
          reason: parsed.reason ?? parsed.actionKey
        });

        return {
          ok: true,
          dry_run: true,
          callback: "feishu.card",
          action_key: parsed.actionKey,
          request_id: parsed.requestId,
          handled_as: "reject",
          confirmation
        };
      }

      const previewAction =
        PREVIEW_STUB_CARD_ACTIONS[parsed.actionKey as keyof typeof PREVIEW_STUB_CARD_ACTIONS];
      if (previewAction !== undefined) {
        const preview = cardPreviewStubAction({
          repos: input.repos,
          id: parsed.requestId,
          action: previewAction
        });
        if (preview === null) {
          return reply
            .code(404)
            .send({ ok: false, error: `Confirmation request not found: ${parsed.requestId}` });
        }

        return {
          callback: "feishu.card",
          action_key: parsed.actionKey,
          request_id: parsed.requestId,
          handled_as: "preview_stub",
          ...preview
        };
      }

      return reply.code(400).send({
        ok: false,
        dry_run: true,
        action_key: parsed.actionKey,
        request_id: parsed.requestId,
        error: `Unsupported Feishu card action_key: ${parsed.actionKey}`
      });
    } catch (error) {
      return reply.code(409).send({
        ok: false,
        dry_run: true,
        action_key: parsed.actionKey,
        request_id: parsed.requestId,
        error: briefError(error)
      });
    }
  });

  app.post("/webhooks/feishu/card-action", async (request, reply) => {
    const parsed = extractCardCallbackPayload(request.body ?? {});

    if (parsed.requestId === null) {
      return reply.code(404).send(toast("error", "确认请求不存在"));
    }

    const confirmation = input.repos.getConfirmationRequest(parsed.requestId);
    if (confirmation === null) {
      return reply.code(404).send(toast("error", "确认请求不存在"));
    }

    if (parsed.actionKey === null) {
      return reply.code(400).send(toast("error", "暂不支持此操作"));
    }

    try {
      if (CONFIRM_CARD_ACTION_KEYS.has(parsed.actionKey)) {
        const result = await confirmRequest({
          repos: input.repos,
          config: input.config,
          id: parsed.requestId,
          editedPayload: parsed.editedPayload,
          runner: input.larkCliRunner
        });

        return {
          ok: result.confirmation.status !== "failed",
          confirmation_id: parsed.requestId,
          action: parsed.actionKey,
          confirmation: result.confirmation,
          result: result.result,
          ...toast("success", "已确认")
        };
      }

      if (REJECT_CARD_ACTION_KEYS.has(parsed.actionKey)) {
        const result = rejectRequest({
          repos: input.repos,
          id: parsed.requestId,
          reason: parsed.reason ?? parsed.actionKey
        });

        return {
          ok: true,
          confirmation_id: parsed.requestId,
          action: parsed.actionKey,
          confirmation: result,
          ...toast("success", "已拒绝")
        };
      }

      const previewAction =
        PREVIEW_STUB_CARD_ACTIONS[parsed.actionKey as keyof typeof PREVIEW_STUB_CARD_ACTIONS];
      if (previewAction !== undefined) {
        return {
          ok: true,
          dry_run: true,
          confirmation_id: parsed.requestId,
          action: previewAction,
          message: CardActionPendingMessage,
          ...toast("success", CardActionPendingMessage)
        };
      }

      return reply.code(400).send(toast("error", "暂不支持此操作"));
    } catch (error) {
      request.log.error(
        { err: error, confirmation_id: parsed.requestId, action: parsed.actionKey },
        "card action failed"
      );
      return reply.code(500).send({
        ok: false,
        confirmation_id: parsed.requestId,
        action: parsed.actionKey,
        ...toast("error", briefError(error))
      });
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
    return processMeetingWorkflow({
      repos: input.repos,
      llm: input.llm,
      meeting
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
