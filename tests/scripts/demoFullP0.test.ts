import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFullP0Demo } from "../../scripts/demo-full-p0";
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
  return JSON.parse(await readFile(join(process.cwd(), "fixtures/expected", name), "utf8")) as MeetingExtractionResult;
}

function fetchViaInject(app: ReturnType<typeof buildServer>): typeof fetch {
  return async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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

      const createKbRequests = repos.listConfirmationRequests().filter((request) => request.request_type === "create_kb");
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

      const latestJson = JSON.parse(await readFile(join(outputDir, "p0-demo-latest.json"), "utf8")) as {
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
  ] as const)("runs %s mode without executing confirmations", async (mode, expectedCardSendRuns) => {
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

    await app.ready();
    try {
      const result = await runFullP0Demo({
        baseUrl: "http://meeting-atlas.test",
        fetchFn: fetchViaInject(app),
        log: () => undefined,
        writeOutputs: false,
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
      expect(result.state.confirmation_requests.every((request) => request.status === "sent")).toBe(true);
      expect(result.state.knowledge_bases).toHaveLength(0);
      expect(result.state.cli_runs.filter((run) => run.tool === "lark.im.send_card")).toHaveLength(
        expectedCardSendRuns
      );
    } finally {
      await app.close();
    }
  });
});
