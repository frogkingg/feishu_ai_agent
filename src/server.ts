import Fastify from "fastify";
import { z, ZodError } from "zod";
import { AppConfig } from "./config";
import { ManualMeetingInputSchema } from "./schemas";
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

  app.get("/dev/confirmations", async () => input.repos.listConfirmationRequests());

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

  app.get("/dev/state", async () => input.repos.getStateSummary());

  return app;
}
