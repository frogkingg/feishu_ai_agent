import { AppConfig } from "../config";
import { Repositories } from "../services/store/repositories";
import {
  buildMinutesDigestTranscriptText,
  extractMinutesDigestArtifacts,
  hasMinutesDigestEvidenceContent
} from "../utils/minutesDigest";
import { runLarkCli, type LarkCliRunner } from "./larkCli";

const TranscriptDryRunText = "【transcript pending - dry-run mode】";

export async function fetchTranscript(input: {
  repos: Repositories;
  config: AppConfig;
  meetingId: string;
  title?: string | null;
  minuteToken?: string | null;
  runner?: LarkCliRunner;
}): Promise<string> {
  if (input.config.feishuReadDryRun) {
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

  if (result.parsed !== null) {
    const artifacts = extractMinutesDigestArtifacts(result.parsed);
    const digestInput = {
      title: input.title ?? artifacts.title,
      externalMeetingId: input.meetingId ?? artifacts.externalMeetingId,
      minuteToken: input.minuteToken ?? artifacts.minuteToken,
      sourceLinks: artifacts.sourceLinks,
      summary: artifacts.summary,
      todos: artifacts.todos,
      chapters: artifacts.chapters,
      keyPoints: artifacts.keyPoints,
      transcriptText: artifacts.transcriptText
    };

    if (hasMinutesDigestEvidenceContent(digestInput)) {
      return buildMinutesDigestTranscriptText(digestInput);
    }
  }

  const stdoutText = result.stdout.trim();
  if (stdoutText.length > 0) {
    return buildMinutesDigestTranscriptText({
      title: input.title ?? null,
      externalMeetingId: input.meetingId,
      minuteToken: input.minuteToken ?? null,
      transcriptText: stdoutText
    });
  }

  throw new Error("lark.vc.notes succeeded without usable minutes digest content");
}
