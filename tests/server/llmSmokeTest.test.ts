import { loadConfig } from "../../src/config";
import { MeetingExtractionResultSchema } from "../../src/schemas";
import { buildServer } from "../../src/server";
import { GenerateJsonInput, LlmClient } from "../../src/services/llm/llmClient";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

class InvalidLlmClient implements LlmClient {
  async generateJson<T>(_input: GenerateJsonInput): Promise<T> {
    return { action_items: "not-an-array" } as T;
  }
}

describe("POST /dev/llm/smoke-test", () => {
  it("runs in mock mode and does not write database state", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({ llmProvider: "mock", sqlitePath: ":memory:" }),
      repos,
      llm: new MockLlmClient()
    });

    const response = await app.inject({
      method: "POST",
      url: "/dev/llm/smoke-test",
      payload: {
        text: "张三下周五前整理无人机操作流程。下周二上午十点再约一次操作员访谈。"
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      provider: string;
      model: string;
      ok: boolean;
      result: unknown;
    };
    expect(body.provider).toBe("mock");
    expect(body.model).toBe("mock");
    expect(body.ok).toBe(true);
    expect(() => MeetingExtractionResultSchema.parse(body.result)).not.toThrow();
    expect(repos.listMeetings()).toHaveLength(0);
    expect(repos.listActionItems()).toHaveLength(0);
    expect(repos.listCalendarDrafts()).toHaveLength(0);
    expect(repos.listConfirmationRequests()).toHaveLength(0);
  });

  it("returns 500 with a brief reason when extraction schema validation fails", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({ llmProvider: "mock", sqlitePath: ":memory:" }),
      repos,
      llm: new InvalidLlmClient()
    });

    const response = await app.inject({
      method: "POST",
      url: "/dev/llm/smoke-test",
      payload: {
        text: "随便一段会议转写。"
      }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      provider: "mock",
      model: "mock",
      ok: false
    });
    expect((response.json() as { error: string }).error).toContain("schema validation failed");
    expect(repos.listConfirmationRequests()).toHaveLength(0);
  });
});
