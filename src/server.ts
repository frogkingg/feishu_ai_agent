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

const FeishuCardActionPayloadSchema = z
  .object({
    open_id: z.string().optional(),
    action: z
      .object({
        value: z.record(z.unknown()).default({})
      })
      .passthrough()
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

function normalizeCardAction(
  action: string | null
): "confirm" | "reject" | "remind_later" | "convert_to_task" | "append_current_only" | null {
  if (action === null) {
    return null;
  }

  if (["confirm", "confirm_with_edits", "create_kb", "edit_and_create"].includes(action)) {
    return "confirm";
  }

  if (["reject", "not_mine", "never_remind_topic"].includes(action)) {
    return "reject";
  }

  if (
    action === "remind_later" ||
    action === "convert_to_task" ||
    action === "append_current_only"
  ) {
    return action;
  }

  return null;
}

function nonTemplateString(value: string | null): string | null {
  return value !== null && value.startsWith("$") ? null : value;
}

function toast(type: "success" | "error", content: string) {
  return {
    toast: {
      type,
      content
    }
  };
}

function briefError(error: unknown): string {
  if (error instanceof ZodError) {
    return `schema validation failed: ${error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "result"} ${issue.message}`)
      .join("; ")}`;
  }

  return error instanceof Error ? error.message : String(error);
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

export function buildServer(input: { config: AppConfig; repos: Repositories; llm: LlmClient }) {
  const app = Fastify({
    logger: true
  });
  configureJsonBodyParser(app);

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
          transcript_text: TranscriptPendingText
        }
      })
        .then((result) => {
          request.log.info(
            {
              event_type: eventType,
              external_meeting_id: event.meeting_id,
              meeting_id: result.meeting_id,
              confirmation_requests: result.confirmation_requests.length
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

  app.post("/webhooks/feishu/card-action", async (request, reply) => {
    const parsedBody = FeishuCardActionPayloadSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send(toast("error", "卡片回调格式不正确"));
    }

    const body = parsedBody.data;
    const value = body.action.value;
    const payloadTemplate = asRecord(value.payload_template);
    const confirmationId = firstString([value.confirmation_id, value.request_id]);
    const action = normalizeCardAction(firstString([value.action, value.action_key]));

    if (confirmationId === null) {
      return reply.code(404).send(toast("error", "确认请求不存在"));
    }

    const confirmation = input.repos.getConfirmationRequest(confirmationId);
    if (confirmation === null) {
      return reply.code(404).send(toast("error", "确认请求不存在"));
    }

    if (action === null) {
      return reply.code(400).send(toast("error", "暂不支持此操作"));
    }

    try {
      if (action === "confirm") {
        const editedPayload = value.edited_payload ?? payloadTemplate.edited_payload;
        const result = await confirmRequest({
          repos: input.repos,
          config: input.config,
          id: confirmationId,
          editedPayload: editedPayload === "$editable_fields" ? undefined : editedPayload
        });

        return {
          ok: true,
          confirmation_id: confirmationId,
          action,
          confirmation: result.confirmation,
          ...toast("success", "已确认")
        };
      }

      if (action === "reject") {
        const reason = nonTemplateString(firstString([value.reason, payloadTemplate.reason]));
        const result = rejectRequest({
          repos: input.repos,
          id: confirmationId,
          reason
        });

        return {
          ok: true,
          confirmation_id: confirmationId,
          action,
          confirmation: result,
          ...toast("success", "已拒绝")
        };
      }

      return {
        ok: true,
        dry_run: true,
        confirmation_id: confirmationId,
        action,
        message: CardActionPendingMessage,
        ...toast("success", CardActionPendingMessage)
      };
    } catch (error) {
      request.log.error(
        { err: error, confirmation_id: confirmationId, action },
        "card action failed"
      );
      return reply.code(500).send({
        ok: false,
        confirmation_id: confirmationId,
        action,
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
      identity: body.identity
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
        identity: body.identity
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
      editedPayload: body.edited_payload
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

  app.get("/dev/state", async () => input.repos.getStateSummary());

  return app;
}
