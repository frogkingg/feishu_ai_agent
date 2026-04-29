import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rejectRequest } from "../../src/services/confirmationService";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

describe("reject confirmation request", () => {
  it("updates status and does not execute CLI", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );

    await processMeetingWorkflow({
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

    const request = repos.listConfirmationRequests().find((item) => item.request_type === "action");
    expect(request).toBeTruthy();

    rejectRequest({
      repos,
      id: request!.id,
      reason: "不是我的"
    });

    expect(repos.getConfirmationRequest(request!.id)?.status).toBe("rejected");
    expect(repos.getActionItem(request!.target_id)?.confirmation_status).toBe("rejected");
    expect(repos.listCliRuns()).toHaveLength(0);
  });
});
