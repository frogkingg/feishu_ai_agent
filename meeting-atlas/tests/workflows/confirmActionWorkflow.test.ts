import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { confirmRequest } from "../../src/services/confirmationService";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

describe("confirm action request", () => {
  it("marks action executed and records cli_runs in dry-run mode", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const transcript = readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"), "utf8");

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

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark" }),
      id: request!.id
    });

    const updatedRequest = repos.getConfirmationRequest(request!.id);
    const action = repos.getActionItem(request!.target_id);
    expect(updatedRequest?.status).toBe("executed");
    expect(action?.confirmation_status).toBe("created");
    expect(action?.feishu_task_guid).toContain("dry_task_");
    expect(repos.listCliRuns()).toHaveLength(1);
  });
});
