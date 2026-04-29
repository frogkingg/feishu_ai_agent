import Fastify from "fastify";
import { z, ZodError } from "zod";
import { AppConfig } from "./config";
import { ManualMeetingInputSchema } from "./schemas";
import { buildConfirmationCardFromRequest } from "./agents/cardInteractionAgent";
import { runMeetingExtractionAgent } from "./agents/meetingExtractionAgent";
import { confirmRequest, rejectRequest } from "./services/confirmationService";
import { LlmClient } from "./services/llm/llmClient";
import { MeetingRow, Repositories } from "./services/store/repositories";
import { nowIso } from "./utils/dates";
import { processMeetingWorkflow } from "./workflows/processMeetingWorkflow";

const LlmSmokeTestInputSchema = z.object({
  text: z.string().min(1)
});

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

function isUnfinishedConfirmation(request: ReturnType<Repositories["listConfirmationRequests"]>[number]): boolean {
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

export function buildServer(input: {
  config: AppConfig;
  repos: Repositories;
  llm: LlmClient;
}) {
  const app = Fastify({
    logger: true
  });

  app.get("/health", async () => ({
    ok: true,
    service: "meeting-atlas",
    phase: "phase-6",
    dry_run: input.config.feishuDryRun,
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
