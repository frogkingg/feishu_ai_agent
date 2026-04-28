import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { MeetingExtractionResultSchema } from "../../src/schemas";

describe("MockLlmClient", () => {
  it("returns stable extraction for drone_interview_01 fixture", async () => {
    const transcript = readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"), "utf8");
    const llm = new MockLlmClient();

    const raw = await llm.generateJson<unknown>({
      systemPrompt: "mock",
      userPrompt: transcript,
      schemaName: "MeetingExtractionResult"
    });
    const parsed = MeetingExtractionResultSchema.parse(raw);

    expect(parsed.action_items[0].title).toBe("整理无人机现有操作流程");
    expect(parsed.calendar_drafts[0].title).toBe("无人机操作员访谈");
  });
});
