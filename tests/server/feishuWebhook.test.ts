import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

function createApp() {
  return buildServer({
    config: loadConfig({ sqlitePath: ":memory:" }),
    repos: createRepositories(createMemoryDatabase()),
    llm: new MockLlmClient()
  });
}

describe("POST /webhooks/feishu/event", () => {
  it("returns the Feishu challenge value", async () => {
    const app = createApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      payload: { challenge: "challenge-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-token" });
  });

  it("accepts unrecognized events", async () => {
    const app = createApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/event",
      payload: { header: { event_type: "unknown.event" }, event: { id: "evt_001" } }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
  });
});
