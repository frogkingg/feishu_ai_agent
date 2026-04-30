import Fastify from "fastify";
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
import { nowIso } from "./utils/dates";
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
    actionValue.request_id,
    root.request_id,
    valueAtPath(payload, ["event", "request_id"])
  ]);
  const actionKey = firstString([
    actionValue.action_key,
    actionValue.key,
    actionValue.action,
    root.action_key,
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
    const payload = (request.body ?? {}) as { challenge?: unknown };
    request.log.info({ payload }, "received feishu event webhook");

    if (typeof payload.challenge === "string") {
      return { challenge: payload.challenge };
    }

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
