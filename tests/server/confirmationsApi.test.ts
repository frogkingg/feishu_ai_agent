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

    const listResponse = await app.inject({
      method: "GET",
      url: "/dev/confirmations"
    });
    const confirmations = listResponse.json() as Array<{
      request_type: string;
      dry_run_card?: { card_type: string; actions: Array<{ key: string }> };
    }>;
    expect(listResponse.statusCode).toBe(200);
    expect(confirmations.find((item) => item.request_type === "action")?.dry_run_card).toMatchObject({
      card_type: "action_confirmation"
    });
    expect(confirmations.find((item) => item.request_type === "calendar")?.dry_run_card).toMatchObject({
      card_type: "calendar_confirmation"
    });
    expect(confirmations.find((item) => item.request_type === "action")?.dry_run_card?.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject",
      "not_mine",
      "remind_later"
    ]);
    expect(confirmations.find((item) => item.request_type === "calendar")?.dry_run_card?.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject",
      "convert_to_task",
      "remind_later"
    ]);

    const cardsResponse = await app.inject({
      method: "GET",
      url: "/dev/cards"
    });
    const cards = cardsResponse.json() as Array<{ request_id: string; card_type: string }>;
    expect(cardsResponse.statusCode).toBe(200);
    expect(cards).toHaveLength(confirmations.length);
    expect(cards.map((card) => card.request_id)).toEqual(
      expect.arrayContaining([action!.id, calendar!.id])
    );
    expect(cards.map((card) => card.card_type)).toEqual(
      expect.arrayContaining(["action_confirmation", "calendar_confirmation"])
    );

    const actionCardResponse = await app.inject({
      method: "GET",
      url: `/dev/confirmations/${action!.id}/card`
    });
    expect(actionCardResponse.statusCode).toBe(200);
    expect(actionCardResponse.json()).toMatchObject({
      card_type: "action_confirmation",
      request_id: action!.id,
      dry_run: true
    });

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

    const unfinishedCardsResponse = await app.inject({
      method: "GET",
      url: "/dev/cards"
    });
    const unfinishedCards = unfinishedCardsResponse.json() as Array<{ request_id: string }>;
    expect(unfinishedCardsResponse.statusCode).toBe(200);
    expect(unfinishedCards.map((card) => card.request_id)).not.toContain(action!.id);
    expect(unfinishedCards.map((card) => card.request_id)).not.toContain(calendar!.id);

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
