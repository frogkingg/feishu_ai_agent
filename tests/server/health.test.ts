import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

describe("GET /health", () => {
  it("returns service status without binding a port", async () => {
    const config = loadConfig({ sqlitePath: ":memory:" });
    const app = buildServer({
      config,
      repos: createRepositories(createMemoryDatabase()),
      llm: new MockLlmClient()
    });

    const response = await app.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "meeting-atlas",
      phase: "phase-6",
      llm_provider: "mock"
    });
  });
});
