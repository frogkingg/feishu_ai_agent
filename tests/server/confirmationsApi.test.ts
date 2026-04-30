import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { MeetingExtractionResult } from "../../src/schemas";
import { buildServer } from "../../src/server";
import { LlmClient } from "../../src/services/llm/llmClient";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { type LarkCliRunner } from "../../src/tools/larkCli";

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

function readExpectedExtraction(name: string): MeetingExtractionResult {
  return JSON.parse(
    readFileSync(join(process.cwd(), "fixtures/expected", name), "utf8")
  ) as MeetingExtractionResult;
}

function firstDroneExtraction(): MeetingExtractionResult {
  return {
    ...readExpectedExtraction("drone_interview_01.extraction.json"),
    topic_keywords: ["无人机", "操作流程", "试飞权限", "操作员访谈"]
  };
}

function secondDroneExtraction(): MeetingExtractionResult {
  return readExpectedExtraction("drone_interview_02.extraction.json");
}

function thirdDroneExtraction(): MeetingExtractionResult {
  return {
    ...secondDroneExtraction(),
    meeting_summary:
      "本次会议继续围绕无人机操作方案风险评审，明确试飞权限、现场安全员和电池状态检查仍需跟进。",
    topic_keywords: ["无人机", "操作流程", "试飞权限", "风险控制"],
    key_decisions: [
      {
        decision: "试飞前必须完成场地权限、现场安全员和电池状态三项检查。",
        evidence: "试飞前必须确认场地权限、现场安全员和电池状态。"
      }
    ],
    risks: [
      {
        risk: "试飞权限尚未确认会阻塞试飞排期。",
        evidence: "会议强调试飞前必须确认场地权限。"
      }
    ],
    action_items: [
      {
        title: "确认试飞权限",
        description: "在试飞前完成场地权限确认。",
        owner: "李四",
        collaborators: [],
        due_date: "2026-05-06",
        priority: "P1",
        evidence: "试飞前必须确认场地权限。",
        confidence: 0.88,
        suggested_reason: "会议明确提出权限确认要求。",
        missing_fields: []
      }
    ],
    calendar_drafts: []
  };
}

function cardSendArgsForConfirmation(
  repos: ReturnType<typeof createRepositories>,
  confirmationId: string
): string[] {
  const run = repos.listCliRuns().find((cliRun) => {
    if (cliRun.tool !== "lark.im.send_card") {
      return false;
    }

    const args = JSON.parse(cliRun.args_json) as string[];
    return args.includes(`meeting-atlas-card-${confirmationId}`);
  });
  expect(run).toBeTruthy();
  return JSON.parse(run!.args_json) as string[];
}

describe("confirmation dev APIs", () => {
  it("confirms and rejects requests through HTTP", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        larkCliBin: "definitely-not-real-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new MockLlmClient()
    });
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );

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
    const calendar = repos
      .listConfirmationRequests()
      .find((item) => item.request_type === "calendar");

    const listResponse = await app.inject({
      method: "GET",
      url: "/dev/confirmations"
    });
    const confirmations = listResponse.json() as Array<{
      request_type: string;
      dry_run_card?: { card_type: string; actions: Array<{ key: string }> };
    }>;
    expect(listResponse.statusCode).toBe(200);
    expect(
      confirmations.find((item) => item.request_type === "action")?.dry_run_card
    ).toMatchObject({
      card_type: "action_confirmation"
    });
    expect(
      confirmations.find((item) => item.request_type === "calendar")?.dry_run_card
    ).toMatchObject({
      card_type: "calendar_confirmation"
    });
    expect(
      confirmations
        .find((item) => item.request_type === "action")
        ?.dry_run_card?.actions.map((action) => action.key)
    ).toEqual(["confirm", "confirm_with_edits", "reject", "not_mine", "remind_later"]);
    expect(
      confirmations
        .find((item) => item.request_type === "calendar")
        ?.dry_run_card?.actions.map((action) => action.key)
    ).toEqual(["confirm", "confirm_with_edits", "reject", "convert_to_task", "remind_later"]);

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
    const state = stateResponse.json() as {
      cli_runs: unknown[];
      confirmation_requests: Array<{ status: string }>;
    };
    expect(state.cli_runs).toHaveLength(1);
    expect(state.confirmation_requests.some((request) => request.status === "executed")).toBe(true);
    expect(state.confirmation_requests.some((request) => request.status === "rejected")).toBe(true);
  });

  it("serves dry-run card preview stub endpoints for non-terminal card actions", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const firstExtraction = {
      ...readExpectedExtraction("drone_interview_01.extraction.json"),
      topic_keywords: ["无人机", "操作流程", "试飞权限", "操作员访谈"]
    };
    const secondExtraction = readExpectedExtraction("drone_interview_02.extraction.json");
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        larkCliBin: "definitely-not-real-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new QueueLlmClient([firstExtraction, secondExtraction])
    });
    const firstTranscript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );
    const secondTranscript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_02.txt"),
      "utf8"
    );

    await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作方案真实 LLM 测试",
        participants: ["张三", "李四"],
        organizer: "张三",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: firstTranscript
      }
    });
    await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作员访谈",
        participants: ["张三", "王五"],
        organizer: "张三",
        started_at: "2026-04-29T10:00:00+08:00",
        ended_at: "2026-04-29T11:00:00+08:00",
        transcript_text: secondTranscript
      }
    });

    const action = repos.listConfirmationRequests().find((item) => item.request_type === "action");
    const calendar = repos
      .listConfirmationRequests()
      .find((item) => item.request_type === "calendar");
    const createKb = repos
      .listConfirmationRequests()
      .find((item) => item.request_type === "create_kb");

    const remindLaterResponse = await app.inject({
      method: "POST",
      url: `/dev/confirmations/${action!.id}/remind-later`
    });
    expect(remindLaterResponse.statusCode).toBe(200);
    expect(remindLaterResponse.json()).toMatchObject({
      ok: true,
      dry_run: true,
      confirmation_id: action!.id,
      action: "remind_later"
    });

    const convertToTaskResponse = await app.inject({
      method: "POST",
      url: `/dev/confirmations/${calendar!.id}/convert-to-task`
    });
    expect(convertToTaskResponse.statusCode).toBe(200);
    expect(convertToTaskResponse.json()).toMatchObject({
      ok: true,
      dry_run: true,
      confirmation_id: calendar!.id,
      action: "convert_to_task"
    });

    const appendCurrentOnlyResponse = await app.inject({
      method: "POST",
      url: `/dev/confirmations/${createKb!.id}/append-current-only`
    });
    expect(appendCurrentOnlyResponse.statusCode).toBe(200);
    expect(appendCurrentOnlyResponse.json()).toMatchObject({
      ok: true,
      dry_run: true,
      confirmation_id: createKb!.id,
      action: "append_current_only"
    });

    for (const endpoint of [
      "/dev/confirmations/missing/remind-later",
      "/dev/confirmations/missing/convert-to-task",
      "/dev/confirmations/missing/append-current-only"
    ]) {
      const missingResponse = await app.inject({
        method: "POST",
        url: endpoint
      });
      expect(missingResponse.statusCode).toBe(404);
    }

    const cardsResponse = await app.inject({
      method: "GET",
      url: "/dev/cards"
    });
    const cards = cardsResponse.json() as Array<{
      actions: Array<{ key: string; endpoint: string }>;
    }>;
    const supportedEndpointPattern =
      /^\/dev\/confirmations\/[^/]+\/(confirm|reject|remind-later|convert-to-task|append-current-only)$/;
    const endpoints = cards.flatMap((card) => card.actions.map((action) => action.endpoint));
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints.every((endpoint) => supportedEndpointPattern.test(endpoint))).toBe(true);
    expect(endpoints).toEqual(
      expect.arrayContaining([
        `/dev/confirmations/${action!.id}/remind-later`,
        `/dev/confirmations/${calendar!.id}/convert-to-task`,
        `/dev/confirmations/${createKb!.id}/append-current-only`
      ])
    );
  });

  it("dry-run sends one card or all cards through lark.im send-card without changing confirmation status", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        larkCliBin: "definitely-not-real-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new MockLlmClient()
    });
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );

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
    expect(action).toBeTruthy();

    const sendOneResponse = await app.inject({
      method: "POST",
      url: `/dev/confirmations/${action!.id}/send-card`,
      payload: { recipient: "ou_override_user" }
    });
    expect(sendOneResponse.statusCode).toBe(200);
    expect(sendOneResponse.json()).toMatchObject({
      ok: true,
      status: "planned",
      dry_run: true,
      confirmation_id: action!.id,
      recipient: "ou_override_user",
      card_message_id: null
    });
    expect(repos.getConfirmationRequest(action!.id)).toMatchObject({
      status: "sent",
      card_message_id: null
    });

    const totalUnfinished = repos
      .listConfirmationRequests()
      .filter((request) => request.status === "sent").length;
    const sendAllResponse = await app.inject({
      method: "POST",
      url: "/dev/cards/send-all",
      payload: { chat_id: "oc_demo_chat" }
    });
    const sendAll = sendAllResponse.json() as {
      ok: boolean;
      total: number;
      planned: number;
      failed: number;
      results: Array<{ chat_id: string; status: string }>;
    };
    expect(sendAllResponse.statusCode).toBe(200);
    expect(sendAll).toMatchObject({
      ok: true,
      total: totalUnfinished,
      planned: totalUnfinished,
      failed: 0
    });
    expect(sendAll.results.every((result) => result.chat_id === "oc_demo_chat")).toBe(true);

    const cliRuns = repos.listCliRuns();
    expect(cliRuns).toHaveLength(totalUnfinished + 1);
    expect(
      cliRuns.every(
        (run) => run.tool === "lark.im.send_card" && run.dry_run === 1 && run.status === "planned"
      )
    ).toBe(true);
    const sendAllArgs = JSON.parse(cliRuns.at(-1)!.args_json) as string[];
    expect(sendAllArgs).toEqual(expect.arrayContaining(["--chat-id", "oc_demo_chat"]));
    expect(repos.listConfirmationRequests().every((request) => request.status === "sent")).toBe(
      true
    );

    repos.createCliRun({
      id: "cli_non_card",
      tool: "lark.task.create",
      args_json: "[]",
      dry_run: 1,
      status: "planned",
      stdout: "{}",
      stderr: null,
      error: null
    });

    const cardSendRunsResponse = await app.inject({
      method: "GET",
      url: "/dev/card-send-runs"
    });
    const cardSendRuns = cardSendRunsResponse.json() as Array<{
      id: string;
      dry_run: 0 | 1;
      status: string;
      stdout: string | null;
      stderr: string | null;
      error: string | null;
      created_at: string;
      args_json?: string;
      tool?: string;
    }>;
    expect(cardSendRunsResponse.statusCode).toBe(200);
    expect(cardSendRuns).toHaveLength(totalUnfinished + 1);
    expect(cardSendRuns.every((run) => run.id.startsWith("cli_"))).toBe(true);
    expect(cardSendRuns.every((run) => run.dry_run === 1 && run.status === "planned")).toBe(true);
    expect(cardSendRuns[0]).toMatchObject({
      stdout: expect.any(String),
      stderr: null,
      error: null,
      created_at: expect.any(String)
    });
    expect(cardSendRuns[0]).not.toHaveProperty("args_json");
    expect(cardSendRuns[0]).not.toHaveProperty("tool");
  });

  it("keeps knowledge cards personal when send-all targets a chat", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        larkCliBin: "definitely-not-real-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new QueueLlmClient([firstDroneExtraction(), secondDroneExtraction()])
    });

    await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作方案初步访谈",
        participants: ["ou_owner", "ou_member_a"],
        organizer: "ou_owner",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: readFileSync(
          join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
          "utf8"
        )
      }
    });

    await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作员访谈",
        participants: ["ou_owner", "ou_member_b"],
        organizer: "ou_owner",
        started_at: "2026-04-29T10:00:00+08:00",
        ended_at: "2026-04-29T11:00:00+08:00",
        transcript_text: `${readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_02.txt"), "utf8")}
后续要把这两次访谈整理成一个无人机操作方案知识库。`
      }
    });

    const createKb = repos
      .listConfirmationRequests()
      .find((request) => request.request_type === "create_kb");
    expect(createKb).toMatchObject({
      recipient: "ou_owner"
    });

    const sendAllResponse = await app.inject({
      method: "POST",
      url: "/dev/cards/send-all",
      payload: { chat_id: "oc_team_room" }
    });
    expect(sendAllResponse.statusCode).toBe(200);

    const createKbArgs = cardSendArgsForConfirmation(repos, createKb!.id);
    expect(createKbArgs).toEqual(expect.arrayContaining(["--user-id", "ou_owner"]));
    expect(createKbArgs).not.toContain("--chat-id");
    expect(
      repos.listCliRuns().some((cliRun) => {
        const args = JSON.parse(cliRun.args_json) as string[];
        return args.includes("--chat-id") && args.includes("oc_team_room");
      })
    ).toBe(true);
  });

  it("auto-sends knowledge decisions to the organizer even when a chat id is provided", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const runner: LarkCliRunner = async (_bin, _args) => ({
      stdout: JSON.stringify({
        data: {
          message_id: `om_${repos.listCliRuns().length + 1}`
        }
      }),
      stderr: ""
    });
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: true,
        feishuCardSendDryRun: false,
        larkCliBin: "fake-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new QueueLlmClient([
        firstDroneExtraction(),
        secondDroneExtraction(),
        thirdDroneExtraction()
      ]),
      larkCliRunner: runner
    });

    await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作方案初步访谈",
        participants: ["ou_owner", "ou_member_a"],
        organizer: "ou_owner",
        send_to_chat_id: "oc_team_room",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: readFileSync(
          join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
          "utf8"
        )
      }
    });

    await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作员访谈",
        participants: ["ou_owner", "ou_member_b"],
        organizer: "ou_owner",
        send_to_chat_id: "oc_team_room",
        started_at: "2026-04-29T10:00:00+08:00",
        ended_at: "2026-04-29T11:00:00+08:00",
        transcript_text: `${readFileSync(join(process.cwd(), "fixtures/meetings/drone_interview_02.txt"), "utf8")}
后续要把这两次访谈整理成一个无人机操作方案知识库。`
      }
    });

    const createKb = repos
      .listConfirmationRequests()
      .find((request) => request.request_type === "create_kb");
    expect(createKb).toMatchObject({
      recipient: "ou_owner"
    });
    const createKbArgs = cardSendArgsForConfirmation(repos, createKb!.id);
    expect(createKbArgs).toEqual(expect.arrayContaining(["--user-id", "ou_owner"]));
    expect(createKbArgs).not.toContain("--chat-id");
    expect(
      repos.listCliRuns().some((cliRun) => {
        const args = JSON.parse(cliRun.args_json) as string[];
        return args.includes("--chat-id") && args.includes("oc_team_room");
      })
    ).toBe(true);

    const confirmResponse = await app.inject({
      method: "POST",
      url: `/dev/confirmations/${createKb!.id}/confirm`,
      payload: {}
    });
    expect(confirmResponse.statusCode).toBe(200);

    const thirdResponse = await app.inject({
      method: "POST",
      url: "/dev/meetings/manual",
      payload: {
        title: "无人机操作方案风险评审",
        participants: ["ou_owner", "ou_member_b"],
        organizer: "ou_owner",
        send_to_chat_id: "oc_team_room",
        started_at: "2026-05-03T10:00:00+08:00",
        ended_at: "2026-05-03T11:00:00+08:00",
        transcript_text: [
          "本次继续讨论无人机操作方案。",
          "操作流程、试飞权限和风险控制都需要进入已有沉淀。",
          "试飞前必须确认场地权限、现场安全员和电池状态。"
        ].join("\n")
      }
    });
    expect(thirdResponse.statusCode).toBe(200);

    const appendMeeting = repos
      .listConfirmationRequests()
      .find((request) => request.request_type === "append_meeting");
    expect(appendMeeting).toMatchObject({
      recipient: "ou_owner"
    });
    const appendArgs = cardSendArgsForConfirmation(repos, appendMeeting!.id);
    expect(appendArgs).toEqual(expect.arrayContaining(["--user-id", "ou_owner"]));
    expect(appendArgs).not.toContain("--chat-id");
  });

  it("fails send-card in real mode when lark CLI cannot execute", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const failingRunner: LarkCliRunner = async () => {
      throw new Error("fake lark CLI failure");
    };
    const app = buildServer({
      config: loadConfig({
        feishuDryRun: false,
        feishuCardSendDryRun: false,
        larkCliBin: "definitely-not-real-lark",
        sqlitePath: ":memory:"
      }),
      repos,
      llm: new MockLlmClient(),
      larkCliRunner: failingRunner
    });
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );

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

    const confirmationsAfterManualMeeting = repos.listConfirmationRequests();
    const action = confirmationsAfterManualMeeting.find((item) => item.request_type === "action");
    expect(action).toBeTruthy();

    const response = await app.inject({
      method: "POST",
      url: `/dev/confirmations/${action!.id}/send-card`,
      payload: { chat_id: "oc_demo_chat" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      ok: false,
      status: "failed",
      dry_run: false,
      confirmation_id: action!.id,
      card_message_id: null
    });

    const updated = repos.getConfirmationRequest(action!.id);
    expect(updated).toMatchObject({
      status: "sent",
      card_message_id: null
    });
    const cliRuns = repos.listCliRuns();
    expect(cliRuns).toHaveLength(confirmationsAfterManualMeeting.length + 1);
    expect(cliRuns.every((run) => run.tool === "lark.im.send_card")).toBe(true);
    expect(cliRuns.every((run) => run.dry_run === 0 && run.status === "failed")).toBe(true);
    expect(cliRuns.at(-1)).toMatchObject({
      tool: "lark.im.send_card",
      dry_run: 0,
      status: "failed"
    });
  });
});
