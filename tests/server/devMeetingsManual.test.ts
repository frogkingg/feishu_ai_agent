import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { personalWorkspaceName } from "../../src/utils/personalWorkspace";

describe("POST /dev/meetings/manual", () => {
  it("creates at least one action confirmation and one calendar confirmation", async () => {
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );
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
        transcript_text: readFileSync(
          join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
          "utf8"
        )
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
    const secondBody = secondResponse.json() as {
      confirmation_requests: string[];
      topic_match: { suggested_action: string };
    };
    expect(secondBody.topic_match.suggested_action).toBe("ask_create");

    const confirmationsResponse = await app.inject({
      method: "GET",
      url: "/dev/confirmations"
    });
    const confirmations = confirmationsResponse.json() as { id: string; request_type: string }[];
    const createKbRequest = confirmations.find(
      (confirmation) => confirmation.request_type === "create_kb"
    );

    expect(confirmationsResponse.statusCode).toBe(200);
    expect(createKbRequest).toBeTruthy();
    expect(secondBody.confirmation_requests).toContain(createKbRequest!.id);
  });

  it("processes real meeting text into personal task, calendar, and KB confirmation cards", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({ sqlitePath: ":memory:" }),
      repos,
      llm: new MockLlmClient()
    });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/dev/meetings/process-text",
      payload: {
        title: "无人机操作方案初步访谈",
        participants: ["Henry", "李四"],
        organizer: "Henry",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        meeting_url: "https://example.feishu.cn/minutes/min_001",
        transcript_url: "https://example.feishu.cn/minutes/transcript_001",
        transcript_text: readFileSync(
          join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
          "utf8"
        )
      }
    });

    expect(firstResponse.statusCode).toBe(200);
    const firstBody = firstResponse.json() as {
      confirmation_summary: { action: number; calendar: number; create_kb: number };
      confirmation_cards: Array<{ card_type: string; sections: unknown[] }>;
    };

    const secondResponse = await app.inject({
      method: "POST",
      url: "/dev/meetings/process-text",
      payload: {
        title: "无人机操作员访谈",
        participants: ["Henry", "王五"],
        organizer: "Henry",
        started_at: "2026-04-29T10:00:00+08:00",
        ended_at: "2026-04-29T11:00:00+08:00",
        minutes_url: "https://example.feishu.cn/minutes/min_002",
        transcript_url: "https://example.feishu.cn/minutes/transcript_002",
        transcript_text: `${readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_02.txt"), "utf8")}
后续要把这两次访谈整理成一个无人机操作方案知识库。`
      }
    });

    expect(secondResponse.statusCode).toBe(200);
    const secondBody = secondResponse.json() as {
      personal_workspace: { mode: string; name: string; recipient: string | null };
      confirmation_summary: { action: number; calendar: number; create_kb: number };
      confirmation_cards: Array<{ card_type: string; sections: unknown[] }>;
    };
    const combinedSummary = {
      action: firstBody.confirmation_summary.action + secondBody.confirmation_summary.action,
      calendar: firstBody.confirmation_summary.calendar + secondBody.confirmation_summary.calendar,
      create_kb:
        firstBody.confirmation_summary.create_kb + secondBody.confirmation_summary.create_kb
    };
    const combinedCards = [...firstBody.confirmation_cards, ...secondBody.confirmation_cards];

    expect(secondBody.personal_workspace).toEqual({
      mode: "personal",
      name: personalWorkspaceName(),
      recipient: "Henry"
    });
    expect(combinedSummary.action).toBeGreaterThan(0);
    expect(combinedSummary.calendar).toBeGreaterThan(0);
    expect(combinedSummary.create_kb).toBe(1);
    expect(combinedCards.map((card) => card.card_type)).toEqual(
      expect.arrayContaining([
        "action_confirmation",
        "calendar_confirmation",
        "create_kb_confirmation"
      ])
    );

    const cardJson = JSON.stringify(combinedCards);
    expect(cardJson).toContain("https://example.feishu.cn/minutes/min_002");
    expect(cardJson).not.toContain("mtg_");
    expect(cardJson).not.toContain("安全说明");

    const createKbRequest = repos
      .listConfirmationRequests()
      .find((confirmation) => confirmation.request_type === "create_kb");
    expect(createKbRequest).toBeTruthy();
    const createKbPayload = JSON.parse(createKbRequest!.original_payload_json) as {
      knowledge_base_mode?: string;
      workspace_name?: string;
      default_structure?: string[];
      candidate_meeting_refs?: string[];
    };
    expect(createKbPayload).toMatchObject({
      knowledge_base_mode: "personal",
      workspace_name: personalWorkspaceName(),
      default_structure: [
        "00 README / Dashboard",
        "01 Core Content / 主题模块",
        "02 Merged FAQ / 问题合并",
        "03 Archive / 来源追溯",
        "04 Project Board / 行动与风险",
        "05 Timeline / 时间轴与日程",
        "06 Calendar / 日程索引"
      ]
    });
    expect(createKbPayload.candidate_meeting_refs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("https://example.feishu.cn/minutes/min_001"),
        expect.stringContaining("https://example.feishu.cn/minutes/min_002")
      ])
    );
  });
});
