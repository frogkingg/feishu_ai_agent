import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

function createApp(devApiKey: string | null) {
  return buildServer({
    config: loadConfig({
      sqlitePath: ":memory:",
      devApiKey
    }),
    repos: createRepositories(createMemoryDatabase()),
    llm: new MockLlmClient()
  });
}

describe("DEV_API_KEY guard", () => {
  it("requires x-dev-api-key for /dev routes when configured", async () => {
    const app = createApp("dev-secret");

    const unauthorized = await app.inject({
      method: "GET",
      url: "/dev/state"
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ error: "unauthorized" });

    const authorized = await app.inject({
      method: "GET",
      url: "/dev/state",
      headers: {
        "x-dev-api-key": "dev-secret"
      }
    });
    expect(authorized.statusCode).toBe(200);
  });

  it("does not guard non-dev routes", async () => {
    const app = createApp("dev-secret");

    const response = await app.inject({
      method: "GET",
      url: "/health"
    });
    expect(response.statusCode).toBe(200);
  });

  it("requires x-dev-api-key for KB ask routes when configured", async () => {
    const app = createApp("dev-secret");

    const unauthorized = await app.inject({
      method: "POST",
      url: "/kb/kb_demo/ask",
      payload: {
        question: "这个知识库有什么风险？"
      }
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ error: "unauthorized" });

    const authorized = await app.inject({
      method: "POST",
      url: "/kb/kb_demo/ask",
      headers: {
        "x-dev-api-key": "dev-secret"
      },
      payload: {
        question: "这个知识库有什么风险？"
      }
    });
    expect(authorized.statusCode).not.toBe(401);
    expect(authorized.statusCode).not.toBe(503);
  });

  it("keeps local bypass for KB ask routes when DEV_API_KEY is not configured", async () => {
    const app = createApp(null);

    const response = await app.inject({
      method: "POST",
      url: "/kb/kb_demo/ask",
      payload: {
        question: "这个知识库有什么风险？"
      }
    });
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(503);
  });
});
