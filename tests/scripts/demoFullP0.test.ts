import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runFullP0Demo,
  type ConfirmationRequest,
  type DryRunCardPreview,
  type StateResponse
} from "../../scripts/demo-full-p0";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MeetingExtractionResult } from "../../src/schemas";
import { LlmClient } from "../../src/services/llm/llmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";

class QueueLlmClient implements LlmClient {
  constructor(private readonly results: MeetingExtractionResult[]) {}

  async generateJson<T>(): Promise<T> {
    const result = this.results.shift();
    if (!result) {
      throw new Error("QueueLlmClient has no remaining results");
    }
    return result as T;
  }
}

async function readExpectedExtraction(name: string): Promise<MeetingExtractionResult> {
  return JSON.parse(
    await readFile(join(process.cwd(), "fixtures/expected", name), "utf8")
  ) as MeetingExtractionResult;
}

function fetchViaInject(app: ReturnType<typeof buildServer>): typeof fetch {
  return async (input, init) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);
    const requestHeaders = new Headers(init?.headers);
    const injected = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(requestHeaders.entries()),
      payload: init?.body === undefined ? undefined : String(init.body)
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(injected.headers)) {
      if (value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
      }
    }

    return new Response(injected.body, {
      status: injected.statusCode,
      headers
    });
  };
}

describe("demo-full-p0 script", () => {
  it("rejects a dirty database before posting the first meeting", async () => {
    let postedMeeting = false;
    const dirtyState = {
      meetings: [{ id: "mtg_existing_1" }, { id: "mtg_existing_2" }],
      action_items: [{ id: "act_1" }, { id: "act_2" }, { id: "act_3" }],
      calendar_drafts: [{ id: "cal_1" }],
      knowledge_bases: [{ id: "kb_1" }],
      knowledge_updates: [],
      confirmation_requests: Array.from({ length: 5 }, (_, index) => ({
        id: `confirm_${index}`
      })),
      cli_runs: []
    } as unknown as StateResponse;
    const fetchFn: typeof fetch = async (input, init) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            ok: true,
            service: "MeetingAtlas",
            dry_run: true,
            llm_provider: "mock",
            sqlite_path: "/tmp/dirty-demo.db"
          }),
          { status: 200 }
        );
      }

      if (method === "GET" && url.pathname === "/dev/state") {
        return new Response(JSON.stringify(dirtyState), { status: 200 });
      }

      if (method === "POST" && url.pathname === "/dev/meetings/manual") {
        postedMeeting = true;
      }

      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    };

    const error = await runFullP0Demo({
      baseUrl: "http://meeting-atlas.test",
      fetchFn,
      log: () => undefined,
      writeOutputs: false
    }).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(postedMeeting).toBe(false);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Demo requires a clean dry-run database.");
    expect(message).toContain("meetings=2");
    expect(message).toContain("action_items=3");
    expect(message).toContain("calendar_drafts=1");
    expect(message).toContain("knowledge_bases=1");
    expect(message).toContain("confirmation_requests=5");
    expect(message).toContain("SQLITE_PATH=/tmp/meeting-atlas-demo-$(date +%s).db");
  });

  it("reports the first failed send-card error with cli_runs guidance", async () => {
    const actionKeys = ["confirm", "confirm_with_edits", "reject", "not_mine", "remind_later"];
    const calendarKeys = [
      "confirm",
      "confirm_with_edits",
      "reject",
      "convert_to_task",
      "remind_later"
    ];
    const createKbKeys = [
      "create_kb",
      "edit_and_create",
      "append_current_only",
      "reject",
      "never_remind_topic"
    ];
    const makeConfirmation = (
      id: string,
      requestType: ConfirmationRequest["request_type"],
      cardType: string,
      actionKeysForCard: string[]
    ): ConfirmationRequest => ({
      id,
      request_type: requestType,
      target_id: `target_${id}`,
      status: "sent",
      original_payload_json: JSON.stringify({
        draft: {
          title: requestType === "create_kb" ? "创建无人机操作方案知识库" : `任务 ${id}`,
          description: "demo"
        }
      }),
      dry_run_card: {
        card_type: cardType,
        title: `Card ${id}`,
        summary: "summary",
        sections: [],
        editable_fields: [],
        actions: actionKeysForCard.map((key) => ({ key })),
        dry_run: true
      }
    });
    const makeCard = (confirmation: ConfirmationRequest): DryRunCardPreview => ({
      request_id: confirmation.id,
      card_type: confirmation.dry_run_card!.card_type,
      title: confirmation.dry_run_card!.title,
      summary: confirmation.dry_run_card!.summary,
      sections: [],
      editable_fields: [],
      actions: confirmation.dry_run_card!.actions,
      dry_run: true
    });
    const firstConfirmations = [
      makeConfirmation("confirm_action_1", "action", "action_confirmation", actionKeys),
      makeConfirmation("confirm_action_2", "action", "action_confirmation", actionKeys),
      makeConfirmation("confirm_calendar_1", "calendar", "calendar_confirmation", calendarKeys)
    ];
    const allConfirmations = [
      ...firstConfirmations,
      makeConfirmation("confirm_action_3", "action", "action_confirmation", actionKeys),
      makeConfirmation("confirm_create_kb_1", "create_kb", "create_kb_confirmation", createKbKeys)
    ];
    const firstCards = firstConfirmations.map(makeCard);
    const allCards = allConfirmations.map(makeCard);
    let meetingPosts = 0;
    let confirmationLists = 0;
    let cardLists = 0;

    const fetchFn: typeof fetch = async (input, init) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            ok: true,
            service: "MeetingAtlas",
            dry_run: true,
            card_send_dry_run: false,
            llm_provider: "mock",
            sqlite_path: "/tmp/card-send-failure.db"
          }),
          { status: 200 }
        );
      }

      if (method === "GET" && url.pathname === "/dev/state") {
        return new Response(
          JSON.stringify({
            meetings: [],
            action_items: [],
            calendar_drafts: [],
            knowledge_bases: [],
            knowledge_updates: [],
            confirmation_requests: [],
            cli_runs: []
          }),
          { status: 200 }
        );
      }

      if (method === "POST" && url.pathname === "/dev/meetings/manual") {
        meetingPosts += 1;
        return new Response(
          JSON.stringify(
            meetingPosts === 1
              ? {
                  meeting_id: "mtg_first",
                  extraction: { action_items: [{}, {}], calendar_drafts: [{}] },
                  confirmation_requests: firstConfirmations.map((item) => item.id),
                  topic_match: {
                    score: 0,
                    match_reasons: [],
                    suggested_action: "observe",
                    candidate_meeting_ids: []
                  }
                }
              : {
                  meeting_id: "mtg_second",
                  extraction: { action_items: [{}], calendar_drafts: [] },
                  confirmation_requests: ["confirm_action_3", "confirm_create_kb_1"],
                  topic_match: {
                    score: 0.95,
                    match_reasons: ["same drone topic"],
                    suggested_action: "ask_create",
                    candidate_meeting_ids: ["mtg_first", "mtg_second"]
                  }
                }
          ),
          { status: 200 }
        );
      }

      if (method === "GET" && url.pathname === "/dev/confirmations") {
        confirmationLists += 1;
        return new Response(
          JSON.stringify(confirmationLists === 1 ? firstConfirmations : allConfirmations),
          { status: 200 }
        );
      }

      if (method === "GET" && url.pathname === "/dev/cards") {
        cardLists += 1;
        return new Response(JSON.stringify(cardLists === 1 ? firstCards : allCards), {
          status: 200
        });
      }

      if (method === "POST" && url.pathname === "/dev/cards/send-all") {
        return new Response(
          JSON.stringify({
            ok: false,
            total: 5,
            planned: 0,
            sent: 4,
            failed: 1,
            results: [
              {
                confirmation_id: "confirm_action_1",
                card_type: "action_confirmation",
                status: "failed",
                dry_run: false,
                cli_run_id: "cli_failed_1",
                chat_id: "oc_demo_chat",
                recipient: null,
                error: "spawn lark ENOENT"
              }
            ]
          }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    };

    const error = await runFullP0Demo({
      baseUrl: "http://meeting-atlas.test",
      fetchFn,
      log: () => undefined,
      writeOutputs: false,
      mode: "send-cards",
      chatId: "oc_demo_chat"
    }).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Card send reported failed sends.");
    expect(message).toContain("Check /dev/state cli_runs for lark.im.send_card stderr/error.");
    expect(message).toContain("Failed count: 1");
    expect(message).toContain("First failed confirmation_id: confirm_action_1");
    expect(message).toContain("First failed card_type: action_confirmation");
    expect(message).toContain("First failed card send error: spawn lark ENOENT");
    expect(message).not.toContain("Card send should not report failed sends");
    expect(message).not.toContain("Dry-run send-card should not report failed sends");
  });

  it("auto-confirms create_kb, writes knowledge state, and avoids duplicate knowledge-base action confirmations", async () => {
    const firstExtraction = {
      ...(await readExpectedExtraction("drone_interview_01.extraction.json")),
      topic_keywords: ["无人机", "操作流程", "试飞权限", "操作员访谈"]
    };
    const secondExtraction: MeetingExtractionResult = {
      ...(await readExpectedExtraction("drone_interview_02.extraction.json")),
      action_items: [
        {
          title: "整理无人机操作方案知识库",
          description: "把两次访谈归档到知识库，形成无人机操作方案首页。",
          owner: "张三",
          collaborators: [],
          due_date: "2026-05-04",
          priority: "P1",
          evidence: "后续要把这两次访谈整理成一个无人机操作方案知识库。",
          confidence: 0.9,
          suggested_reason: "会议明确提出整理知识库。",
          missing_fields: []
        },
        {
          title: "整理风险清单",
          description: "整理试飞权限、天气、电池状态和现场安全员等风险项。",
          owner: "王五",
          collaborators: [],
          due_date: "2026-05-03",
          priority: "P1",
          evidence: "王五负责在 2026-05-03 前整理风险清单。",
          confidence: 0.88,
          suggested_reason: "王五明确认领风险清单。",
          missing_fields: []
        }
      ]
    };
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        sqlitePath: ":memory:",
        feishuDryRun: true,
        larkCliBin: "definitely-not-real-lark"
      }),
      repos,
      llm: new QueueLlmClient([firstExtraction, secondExtraction])
    });
    const outputDir = await mkdtemp(join(tmpdir(), "meeting-atlas-p0-demo-"));

    await app.ready();
    try {
      const result = await runFullP0Demo({
        baseUrl: "http://meeting-atlas.test",
        outputDir,
        fetchFn: fetchViaInject(app),
        log: () => undefined
      });

      const createKbRequests = repos
        .listConfirmationRequests()
        .filter((request) => request.request_type === "create_kb");
      expect(createKbRequests).toHaveLength(1);
      expect(createKbRequests[0].status).toBe("executed");

      const knowledgeBases = repos.listKnowledgeBases();
      const knowledgeUpdates = repos.listKnowledgeUpdates();
      expect(knowledgeBases).toHaveLength(1);
      expect(knowledgeBases[0]).toMatchObject({
        name: "无人机操作方案",
        status: "active"
      });
      expect(knowledgeBases[0].wiki_url).toMatch(/^mock:\/\//);
      expect(knowledgeBases[0].homepage_url).toMatch(/^mock:\/\//);
      expect(knowledgeUpdates).toHaveLength(1);
      expect(knowledgeUpdates[0].update_type).toBe("kb_created");

      const secondMeetingActionTitles = repos
        .listConfirmationRequests()
        .filter((request) => request.request_type === "action")
        .map((request) => repos.getActionItem(request.target_id))
        .filter((action) => action?.meeting_id === result.second.meeting_id)
        .map((action) => action!.title);
      expect(secondMeetingActionTitles).toEqual(["整理风险清单"]);
      expect(secondMeetingActionTitles).not.toContain("整理无人机操作方案知识库");

      const latestJson = JSON.parse(
        await readFile(join(outputDir, "p0-demo-latest.json"), "utf8")
      ) as {
        status: string;
        knowledge_base_confirmations_executed: number;
        card_previews_generated: number;
        action_cards: number;
        calendar_cards: number;
        knowledge_base_cards: number;
        knowledge_update: string;
      };
      expect(latestJson).toMatchObject({
        status: "passed",
        knowledge_base_confirmations_executed: 1,
        card_previews_generated: 4,
        action_cards: 2,
        calendar_cards: 1,
        knowledge_base_cards: 1,
        knowledge_update: "kb_created"
      });
      expect(result.summary.knowledge_base_confirmations_executed).toBe(1);
      expect(result.summary.card_previews_generated).toBe(4);
      expect(result.summary.action_cards).toBe(2);
      expect(result.summary.calendar_cards).toBe(1);
      expect(result.summary.knowledge_base_cards).toBe(1);
      expect(result.state.knowledge_bases).toHaveLength(1);
      expect(result.state.knowledge_updates).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["cards-only", 0],
    ["send-cards", 5]
  ] as const)(
    "runs %s mode without executing confirmations",
    async (mode, expectedCardSendRuns) => {
      const firstExtraction = {
        ...(await readExpectedExtraction("drone_interview_01.extraction.json")),
        topic_keywords: ["无人机", "操作流程", "试飞权限", "操作员访谈"]
      };
      const secondExtraction: MeetingExtractionResult = {
        ...(await readExpectedExtraction("drone_interview_02.extraction.json")),
        action_items: [
          {
            title: "整理无人机操作方案知识库",
            description: "把两次访谈归档到知识库，形成无人机操作方案首页。",
            owner: "张三",
            collaborators: [],
            due_date: "2026-05-04",
            priority: "P1",
            evidence: "后续要把这两次访谈整理成一个无人机操作方案知识库。",
            confidence: 0.9,
            suggested_reason: "会议明确提出整理知识库。",
            missing_fields: []
          },
          {
            title: "整理风险清单",
            description: "整理试飞权限、天气、电池状态和现场安全员等风险项。",
            owner: "王五",
            collaborators: [],
            due_date: "2026-05-03",
            priority: "P1",
            evidence: "王五负责在 2026-05-03 前整理风险清单。",
            confidence: 0.88,
            suggested_reason: "王五明确认领风险清单。",
            missing_fields: []
          }
        ]
      };
      const repos = createRepositories(createMemoryDatabase());
      const app = buildServer({
        config: loadConfig({
          sqlitePath: ":memory:",
          feishuDryRun: true,
          larkCliBin: "definitely-not-real-lark"
        }),
        repos,
        llm: new QueueLlmClient([firstExtraction, secondExtraction])
      });
      const outputDir = await mkdtemp(join(tmpdir(), `meeting-atlas-${mode}-demo-`));

      await app.ready();
      try {
        const result = await runFullP0Demo({
          baseUrl: "http://meeting-atlas.test",
          outputDir,
          fetchFn: fetchViaInject(app),
          log: () => undefined,
          mode,
          chatId: mode === "send-cards" ? "oc_demo_chat" : undefined
        });

        expect(result.summary.mode).toBe(mode);
        expect(result.summary.action_confirmations_executed).toBe(0);
        expect(result.summary.calendar_confirmations_executed).toBe(0);
        expect(result.summary.knowledge_base_confirmations_executed).toBe(0);
        expect(result.summary.knowledge_base_name).toBe("n/a");
        expect(result.summary.card_previews_generated).toBe(5);
        expect(result.summary.card_send_cli_records).toBe(expectedCardSendRuns);
        expect(
          result.state.confirmation_requests.every((request) => request.status === "sent")
        ).toBe(true);
        expect(result.state.knowledge_bases).toHaveLength(0);
        expect(
          result.state.cli_runs.filter((run) => run.tool === "lark.im.send_card")
        ).toHaveLength(expectedCardSendRuns);

        const outputStem = mode === "cards-only" ? "cards-only-demo" : "send-cards-demo";
        const latestJson = JSON.parse(
          await readFile(join(outputDir, `${outputStem}-latest.json`), "utf8")
        ) as {
          mode: string;
          card_send_cli_records: number;
        };
        const markdownReport = await readFile(join(outputDir, `${outputStem}-report.md`), "utf8");

        expect(latestJson.mode).toBe(mode);
        expect(latestJson.card_send_cli_records).toBe(expectedCardSendRuns);
        expect(markdownReport).toContain(`Mode: ${mode}`);
        expect(markdownReport).toContain("does not execute confirmations");
        await expect(readFile(join(outputDir, "p0-demo-report.md"), "utf8")).rejects.toThrow();
      } finally {
        await app.close();
      }
    }
  );
});
