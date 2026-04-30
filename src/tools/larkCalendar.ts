import { AppConfig } from "../config";
import { CalendarDraftRow, Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

export interface CreateCalendarEventResult {
  calendar_event_id: string;
  event_url: string;
  dry_run: boolean;
  cli_run_id: string;
}

export async function createCalendarEvent(input: {
  repos: Repositories;
  config?: AppConfig;
  draft: CalendarDraftRow;
  runner?: LarkCliRunner;
}): Promise<CreateCalendarEventResult> {
  const args = [
    "calendar",
    "event",
    "create",
    "--title",
    input.draft.title,
    "--start",
    input.draft.start_time ?? "",
    "--end",
    input.draft.end_time ?? "",
    "--participants",
    input.draft.participants_json,
    "--agenda",
    input.draft.agenda ?? ""
  ];

  const result = await runLarkCli(args, {
    repos: input.repos,
    config: input.config,
    toolName: "lark.calendar.create",
    dryRun: input.config?.feishuDryRun,
    expectJson: true,
    runner: input.runner
  });

  if (result.dryRun || result.status === "planned") {
    return {
      calendar_event_id: `dry_event_${input.draft.id}`,
      event_url: `mock://feishu/calendar/${input.draft.id}`,
      dry_run: true,
      cli_run_id: result.id
    };
  }

  if (result.status === "failed") {
    throw new Error(`lark.calendar.create failed: ${result.error ?? "unknown error"}`);
  }

  const parsed = result.parsed as { event_id?: string; event_url?: string } | null;
  if (!parsed?.event_id || !parsed?.event_url) {
    throw new Error("lark.calendar.create succeeded without event_id/event_url");
  }

  return {
    calendar_event_id: parsed.event_id,
    event_url: parsed.event_url,
    dry_run: false,
    cli_run_id: result.id
  };
}
