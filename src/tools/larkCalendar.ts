import { AppConfig } from "../config";
import { CalendarDraftRow, Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

export interface CreateCalendarEventResult {
  calendar_event_id: string;
  event_url: string;
  dry_run: boolean;
  cli_run_id: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function eventFromParsed(parsed: unknown): Record<string, unknown> | null {
  const root = asRecord(parsed);
  return asRecord(asRecord(root?.data)?.event) ?? asRecord(root?.event);
}

function parseParticipantIds(value: string): string {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return "";
  }

  return parsed
    .filter((participant): participant is string => typeof participant === "string")
    .map((participant) => participant.trim())
    .filter((participant) => participant.startsWith("ou_"))
    .join(",");
}

export async function createCalendarEvent(input: {
  repos: Repositories;
  config?: AppConfig;
  draft: CalendarDraftRow;
  runner?: LarkCliRunner;
}): Promise<CreateCalendarEventResult> {
  const participantIds = parseParticipantIds(input.draft.participants_json);
  const args = [
    "calendar",
    "+create",
    "--summary",
    input.draft.title,
    "--start",
    input.draft.start_time ?? "",
    "--end",
    input.draft.end_time ?? "",
    "--description",
    input.draft.agenda ?? "",
    ...(participantIds.length > 0 ? ["--attendee-ids", participantIds] : []),
    "--as",
    "user"
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

  const event = eventFromParsed(result.parsed);
  const eventId = event?.event_id;
  const applink = event?.applink;
  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    typeof applink !== "string" ||
    applink.length === 0
  ) {
    throw new Error("lark.calendar.create succeeded without event_id/applink");
  }

  return {
    calendar_event_id: eventId,
    event_url: applink,
    dry_run: false,
    cli_run_id: result.id
  };
}
