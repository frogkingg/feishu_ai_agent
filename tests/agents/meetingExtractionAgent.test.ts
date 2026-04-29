import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMeetingExtractionAgent } from "../../src/agents/meetingExtractionAgent";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

describe("MeetingExtractionAgent", () => {
  it("validates Mock LLM output with MeetingExtractionResult schema", async () => {
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );
    const repos = createRepositories(createMemoryDatabase());
    const meeting = repos.createMeeting({
      id: "mtg_agent_001",
      external_meeting_id: null,
      title: "无人机操作方案初步访谈",
      started_at: "2026-04-28T10:00:00+08:00",
      ended_at: "2026-04-28T11:00:00+08:00",
      organizer: "张三",
      participants_json: JSON.stringify(["张三", "李四"]),
      minutes_url: null,
      transcript_url: null,
      transcript_text: transcript,
      summary: null,
      keywords_json: JSON.stringify([]),
      matched_kb_id: null,
      match_score: null,
      archive_status: "not_archived",
      action_count: 0,
      calendar_count: 0
    });

    const extraction = await runMeetingExtractionAgent({
      meeting,
      llm: new MockLlmClient()
    });

    expect(extraction.confidence).toBeGreaterThan(0.8);
    expect(extraction.key_decisions[0].decision).toContain("先调研");
  });
});
