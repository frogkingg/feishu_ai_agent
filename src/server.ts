import Fastify from "fastify";
import { AppConfig } from "./config";
import { ManualMeetingInputSchema } from "./schemas";
import { confirmRequest, rejectRequest } from "./services/confirmationService";
import { LlmClient } from "./services/llm/llmClient";
import { Repositories } from "./services/store/repositories";
import { processMeetingWorkflow } from "./workflows/processMeetingWorkflow";

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
    sqlite_path: input.config.sqlitePath
  }));

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
