import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

describe("POST /dev/meetings/manual", () => {
  it("creates at least one action confirmation and one calendar confirmation", async () => {
    const transcript = readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"), "utf8");
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({ sqlitePath: ":memory:" }),
      repos,
      llm: new MockLlmClient()
    });

    const response = await app.inject({
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

    expect(response.statusCode).toBe(200);
    const body = response.json() as { confirmation_requests: string[] };
    expect(body.confirmation_requests.length).toBeGreaterThanOrEqual(2);

    const confirmations = repos.listConfirmationRequests();
    expect(confirmations.some((item) => item.request_type === "action")).toBe(true);
    expect(confirmations.some((item) => item.request_type === "calendar")).toBe(true);

    const confirmationsResponse = await app.inject({
      method: "GET",
      url: "/dev/confirmations"
    });
    expect(confirmationsResponse.statusCode).toBe(200);
    expect((confirmationsResponse.json() as unknown[]).length).toBe(confirmations.length);
  });

  it("returns create_kb confirmations after the second related drone meeting", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({ sqlitePath: ":memory:" }),
      repos,
      llm: new MockLlmClient()
    });

    await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作方案初步访谈",
        participants: ["张三", "李四"],
        organizer: "张三",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"), "utf8")
      }
    });

    const secondResponse = await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作员访谈",
        participants: ["张三", "王五"],
        organizer: "张三",
        started_at: "2026-04-29T10:00:00+08:00",
        ended_at: "2026-04-29T11:00:00+08:00",
        transcript_text: `${readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_02.txt"), "utf8")}
后续要把这两次访谈整理成一个无人机操作方案知识库。`
      }
    });

    expect(secondResponse.statusCode).toBe(200);
    const secondBody = secondResponse.json() as { confirmation_requests: string[]; topic_match: { suggested_action: string } };
    expect(secondBody.topic_match.suggested_action).toBe("ask_create");

    const confirmationsResponse = await app.inject({
      method: "GET",
      url: "/dev/confirmations"
    });
    const confirmations = confirmationsResponse.json() as { id: string; request_type: string }[];
    const createKbRequest = confirmations.find((confirmation) => confirmation.request_type === "create_kb");

    expect(confirmationsResponse.statusCode).toBe(200);
    expect(createKbRequest).toBeTruthy();
    expect(secondBody.confirmation_requests).toContain(createKbRequest!.id);
  });
});
