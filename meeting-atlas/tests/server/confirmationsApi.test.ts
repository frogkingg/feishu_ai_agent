import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

describe("confirmation dev APIs", () => {
  it("confirms and rejects requests through HTTP", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({ feishuDryRun: true, larkCliBin: "definitely-not-real-lark", sqlitePath: ":memory:" }),
      repos,
      llm: new MockLlmClient()
    });
    const transcript = readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"), "utf8");

    await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作方案初步访谈",
        participants: ["张三", "李四"],
        organizer: "张三",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: transcript
      }
    });

    const action = repos.listConfirmationRequests().find((item) => item.request_type === "action");
    const calendar = repos.listConfirmationRequests().find((item) => item.request_type === "calendar");

    const confirmResponse = await app.inject({
      method: "POST",
      url: `/dev/confirmations/${action!.id}/confirm`,
      payload: {}
    });
    expect(confirmResponse.statusCode).toBe(200);

    const rejectResponse = await app.inject({
      method: "POST",
      url: `/dev/confirmations/${calendar!.id}/reject`,
      payload: { reason: "稍后再约" }
    });
    expect(rejectResponse.statusCode).toBe(200);

    const stateResponse = await app.inject({
      method: "GET",
      url: "/dev/state"
    });
    const state = stateResponse.json() as { cli_runs: unknown[]; confirmation_requests: Array<{ status: string }> };
    expect(state.cli_runs).toHaveLength(1);
    expect(state.confirmation_requests.some((request) => request.status === "executed")).toBe(true);
    expect(state.confirmation_requests.some((request) => request.status === "rejected")).toBe(true);
  });
});
