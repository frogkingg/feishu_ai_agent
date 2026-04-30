import { AppConfig } from "../config";
import { Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

const TranscriptDryRunText = "【transcript pending - dry-run mode】";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textFromParsed(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  for (const key of ["transcript", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const data = record.data;
  if (typeof data === "object" && data !== null) {
    return textFromParsed(data);
  }

  return null;
}

function contentFromRecord(record: Record<string, unknown> | null): string | null {
  const content = record?.content;
  return typeof content === "string" && content.trim().length > 0 ? content.trim() : null;
}

function textFromNotesResult(parsed: unknown): string | null {
  const root = asRecord(parsed);
  const notes = root?.data;
  const notesRecord = asRecord(notes);
  const notesArr = notesRecord?.notes;
  if (Array.isArray(notesArr) && notesArr.length > 0) {
    const first = asRecord(notesArr[0]);
    const artifacts = asRecord(first?.artifacts);
    const summary = artifacts?.summary;
    if (typeof summary === "string" && summary.trim().length > 0) {
      return summary.trim();
    }
  }

  const parsedText = textFromParsed(parsed);
  if (parsedText !== null) {
    return parsedText;
  }

  const minutes = root?.minutes;
  if (Array.isArray(minutes) && minutes.length > 0) {
    const content = contentFromRecord(asRecord(minutes[0]));
    if (content !== null) {
      return content;
    }
  }

  if (Array.isArray(parsed) && parsed.length > 0) {
    const content = contentFromRecord(asRecord(parsed[0]));
    if (content !== null) {
      return content;
    }
  }

  return contentFromRecord(root);
}

export async function fetchTranscript(input: {
  repos: Repositories;
  config: AppConfig;
  meetingId: string;
  minuteToken?: string | null;
  runner?: LarkCliRunner;
}): Promise<string> {
  if (input.config.feishuDryRun) {
    return TranscriptDryRunText;
  }

  const args = input.minuteToken
    ? ["vc", "+notes", "--minute-tokens", input.minuteToken, "--format", "json"]
    : ["vc", "+notes", "--meeting-ids", input.meetingId, "--format", "json"];
  const result = await runLarkCli(args, {
    repos: input.repos,
    config: input.config,
    toolName: "lark.vc.notes",
    dryRun: false,
    expectJson: true,
    runner: input.runner
  });

  if (result.status === "failed") {
    throw new Error(`lark.vc.notes failed: ${result.error ?? "unknown error"}`);
  }

  const parsedText = textFromNotesResult(result.parsed);
  if (parsedText !== null) {
    return parsedText;
  }

  const stdoutText = result.stdout.trim();
  if (stdoutText.length > 0) {
    return stdoutText;
  }

  throw new Error("lark.vc.notes succeeded without transcript text");
}
