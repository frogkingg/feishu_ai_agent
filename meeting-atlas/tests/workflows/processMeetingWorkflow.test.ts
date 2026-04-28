import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

describe("processMeetingWorkflow", () => {
  it("generates action and calendar confirmations without side effects", async () => {
    const transcript = readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"), "utf8");
    const repos = createRepositories(createMemoryDatabase());

    const result = await processMeetingWorkflow({
      repos,
      llm: new MockLlmClient(),
      meeting: {
        title: "无人机操作方案初步访谈",
        participants: ["张三", "李四"],
        organizer: "张三",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: transcript
      }
    });

    const confirmations = repos.listConfirmationRequests();
    expect(result.confirmation_requests).toHaveLength(3);
    expect(confirmations.some((item) => item.request_type === "action")).toBe(true);
    expect(confirmations.some((item) => item.request_type === "calendar")).toBe(true);
    expect(repos.listCliRuns()).toHaveLength(0);
  });
});
