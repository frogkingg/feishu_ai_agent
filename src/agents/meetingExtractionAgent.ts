import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MeetingExtractionResult, MeetingExtractionResultSchema } from "../schemas";
import { LlmClient } from "../services/llm/llmClient";
import { MeetingRow } from "../services/store/repositories";

function readPrompt(name: string): string {
  return readFileSync(join(process.cwd(), "src/prompts", name), "utf8");
}

export async function runMeetingExtractionAgent(input: {
  meeting: MeetingRow;
  llm: LlmClient;
}): Promise<MeetingExtractionResult> {
  const raw = await input.llm.generateJson<unknown>({
    systemPrompt: readPrompt("meetingExtraction.md"),
    userPrompt: [
      `title: ${input.meeting.title}`,
      `organizer: ${input.meeting.organizer ?? "unknown"}`,
      `participants: ${input.meeting.participants_json}`,
      "transcript:",
      input.meeting.transcript_text
    ].join("\n"),
    schemaName: "MeetingExtractionResult"
  });

  return MeetingExtractionResultSchema.parse(raw);
}
