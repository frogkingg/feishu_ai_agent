import { AppConfig } from "../config";
import { Repositories } from "../services/store/repositories";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

const TranscriptDryRunText = "【transcript pending - dry-run mode】";

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

export async function fetchTranscript(input: {
  repos: Repositories;
  config: AppConfig;
  meetingId: string;
  runner?: LarkCliRunner;
}): Promise<string> {
  if (input.config.feishuDryRun) {
    return TranscriptDryRunText;
  }

  const result = await runLarkCli(["vc", "transcript", "get", "--meeting-id", input.meetingId], {
    repos: input.repos,
    config: input.config,
    toolName: "lark.vc.transcript.get",
    dryRun: false,
    expectJson: true,
    runner: input.runner
  });

  if (result.status === "failed") {
    throw new Error(`lark.vc.transcript.get failed: ${result.error ?? "unknown error"}`);
  }

  const parsedText = textFromParsed(result.parsed);
  if (parsedText !== null) {
    return parsedText;
  }

  const stdoutText = result.stdout.trim();
  if (stdoutText.length > 0) {
    return stdoutText;
  }

  throw new Error("lark.vc.transcript.get succeeded without transcript text");
}
