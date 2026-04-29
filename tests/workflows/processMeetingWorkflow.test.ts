import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MeetingExtractionResult } from "../../src/schemas";
import { LlmClient } from "../../src/services/llm/llmClient";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

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

describe("processMeetingWorkflow", () => {
  it("generates action and calendar confirmations without side effects", async () => {
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );
    const repos = createRepositories(createMemoryDatabase());

    const result = await processMeetingWorkflow({
      repos,
      llm: new MockLlmClient(),
      meeting: {
        title: "无人机操作方案初步访谈",
        participants: ["张三", "李四"],
        organizer: "张三",
        started_at: "2026-04-28T10:00:00+08:00",
        ended_at: "2026-04-28T11:00:00+08:00",
        transcript_text: transcript
      }
    });

    const confirmations = repos.listConfirmationRequests();
    const actionRequest = confirmations.find((item) => item.request_type === "action");
    const calendarRequest = confirmations.find((item) => item.request_type === "calendar");
    const actionPayload = JSON.parse(actionRequest!.original_payload_json) as {
      draft?: unknown;
      meeting_id?: string;
      card_preview?: { card_type: string; request_id: string; actions: Array<{ key: string }> };
    };
    const calendarPayload = JSON.parse(calendarRequest!.original_payload_json) as {
      draft?: unknown;
      meeting_id?: string;
      card_preview?: { card_type: string; request_id: string; actions: Array<{ key: string }> };
    };

    expect(result.confirmation_requests).toHaveLength(3);
    expect(confirmations.some((item) => item.request_type === "action")).toBe(true);
    expect(confirmations.some((item) => item.request_type === "calendar")).toBe(true);
    expect(actionPayload.draft).toBeTruthy();
    expect(actionPayload.meeting_id).toBe(result.meeting_id);
    expect(actionPayload.card_preview).toMatchObject({
      card_type: "action_confirmation",
      request_id: actionRequest!.id
    });
    expect(actionPayload.card_preview?.actions.map((action) => action.key)).toEqual([
      "confirm",
      "confirm_with_edits",
      "reject",
      "not_mine",
      "remind_later"
    ]);
    expect(calendarPayload.draft).toBeTruthy();
    expect(calendarPayload.meeting_id).toBe(result.meeting_id);
    expect(calendarPayload.card_preview).toMatchObject({
      card_type: "calendar_confirmation",
      request_id: calendarRequest!.id
    });
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("does not create duplicate action confirmations for knowledge-base creation tasks when create_kb is suggested", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const firstExtraction = {
      ...readExpectedExtraction("drone_interview_01.extraction.json"),
      topic_keywords: ["无人机", "操作流程", "试飞权限", "操作员访谈"]
    };
    const secondExtraction: MeetingExtractionResult = {
      ...readExpectedExtraction("drone_interview_02.extraction.json"),
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
        },
        {
          title: "建立 SOP",
          description: "建立统一无人机操作 SOP。",
          owner: "张三",
          collaborators: [],
          due_date: "2026-05-05",
          priority: "P1",
          evidence: "需要建立统一无人机操作 SOP。",
          confidence: 0.82,
          suggested_reason: "会议明确提出统一 SOP。",
          missing_fields: []
        },
        {
          title: "确认试飞权限",
          description: "确认试飞前权限审批材料。",
          owner: "李四",
          collaborators: [],
          due_date: "2026-05-02",
          priority: "P1",
          evidence: "试飞前权限确认分散，需要统一确认。",
          confidence: 0.81,
          suggested_reason: "会议指出试飞权限确认分散。",
          missing_fields: []
        }
      ]
    };
    const llm = new QueueLlmClient([firstExtraction, secondExtraction]);

    await processMeetingWorkflow({
      repos,
      llm,
      meeting: {
        title: "无人机操作方案真实 LLM 测试",
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
    const second = await processMeetingWorkflow({
      repos,
      llm,
      meeting: {
        title: "无人机操作员访谈",
        participants: ["张三", "王五"],
        organizer: "张三",
        started_at: "2026-04-29T10:00:00+08:00",
        ended_at: "2026-04-29T11:00:00+08:00",
        transcript_text: [
          "继续讨论无人机操作方案。",
          "操作流程不统一，试飞前权限确认分散。",
          "需要建立统一无人机操作 SOP，并补充风险控制清单。",
          "王五负责在 2026-05-03 前整理风险清单。",
          "后续要把这两次访谈整理成一个无人机操作方案知识库。"
        ].join("\n")
      }
    });

    expect(second.topic_match.suggested_action).toBe("ask_create");
    expect(
      repos.listConfirmationRequests().some((request) => request.request_type === "create_kb")
    ).toBe(true);

    const secondActionTitles = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "action")
      .map((request) => repos.getActionItem(request.target_id))
      .filter((action) => action?.meeting_id === second.meeting_id)
      .map((action) => action!.title);

    expect(secondActionTitles).toEqual(["整理风险清单", "建立 SOP", "确认试飞权限"]);
    expect(secondActionTitles).not.toContain("整理无人机操作方案知识库");
  });
});
