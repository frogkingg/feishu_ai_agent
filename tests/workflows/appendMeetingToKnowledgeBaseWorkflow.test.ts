import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { MeetingExtractionResult } from "../../src/schemas";
import { confirmRequest, rejectRequest } from "../../src/services/confirmationService";
import { LlmClient } from "../../src/services/llm/llmClient";
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

function readFixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures/meetings", name), "utf8");
}

function readExpected(name: string): MeetingExtractionResult {
  return JSON.parse(
    readFileSync(join(process.cwd(), "fixtures/expected", name), "utf8")
  ) as MeetingExtractionResult;
}

function firstDroneExtraction(): MeetingExtractionResult {
  return {
    ...readExpected("drone_interview_01.extraction.json"),
    topic_keywords: ["无人机", "操作流程", "试飞权限", "操作员访谈"]
  };
}

function secondDroneExtraction(): MeetingExtractionResult {
  return readExpected("drone_interview_02.extraction.json");
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
    calendar_drafts: [
      {
        title: "无人机试飞前检查会议",
        start_time: "2026-05-05T10:00:00+08:00",
        end_time: "2026-05-05T10:30:00+08:00",
        duration_minutes: 30,
        participants: ["张三", "李四", "王五"],
        agenda: "确认试飞权限、现场安全员和电池状态。",
        location: null,
        evidence: "试飞前必须确认场地权限、现场安全员和电池状态。",
        confidence: 0.84,
        missing_fields: ["location"]
      }
    ]
  };
}

async function processFirstDroneMeeting(input: {
  repos: ReturnType<typeof createRepositories>;
  llm: LlmClient;
}) {
  return processMeetingWorkflow({
    repos: input.repos,
    llm: input.llm,
    meeting: {
      title: "无人机操作方案初步访谈",
      participants: ["张三", "李四"],
      organizer: "张三",
      started_at: "2026-04-28T10:00:00+08:00",
      ended_at: "2026-04-28T11:00:00+08:00",
      transcript_text: readFixture("drone_interview_01.txt")
    }
  });
}

async function processSecondDroneMeeting(input: {
  repos: ReturnType<typeof createRepositories>;
  llm: LlmClient;
}) {
  return processMeetingWorkflow({
    repos: input.repos,
    llm: input.llm,
    meeting: {
      title: "无人机操作员访谈",
      participants: ["张三", "王五"],
      organizer: "张三",
      started_at: "2026-04-29T10:00:00+08:00",
      ended_at: "2026-04-29T11:00:00+08:00",
      transcript_text: readFixture("drone_interview_02.txt")
    }
  });
}

async function processThirdDroneMeeting(input: {
  repos: ReturnType<typeof createRepositories>;
  llm: LlmClient;
}) {
  return processMeetingWorkflow({
    repos: input.repos,
    llm: input.llm,
    meeting: {
      title: "无人机操作方案风险评审",
      participants: ["张三", "王五", "李四"],
      organizer: "张三",
      started_at: "2026-05-03T10:00:00+08:00",
      ended_at: "2026-05-03T11:00:00+08:00",
      transcript_text: [
        "本次继续讨论无人机操作方案。",
        "操作流程、试飞权限和风险控制都需要进入已有沉淀。",
        "试飞前必须确认场地权限、现场安全员和电池状态。"
      ].join("\n")
    }
  });
}

async function createActiveDroneKnowledgeBase(input: {
  repos: ReturnType<typeof createRepositories>;
  llm: LlmClient;
}) {
  await processFirstDroneMeeting(input);
  await processSecondDroneMeeting(input);
  const createKbRequest = input.repos
    .listConfirmationRequests()
    .find((request) => request.request_type === "create_kb");
  expect(createKbRequest).toBeTruthy();

  await confirmRequest({
    repos: input.repos,
    config: loadConfig({ feishuDryRun: true, sqlitePath: ":memory:" }),
    id: createKbRequest!.id
  });

  return input.repos.listKnowledgeBases()[0];
}

describe("appendMeetingToKnowledgeBaseWorkflow", () => {
  it("requires confirmation before appending and then records a meeting_added update", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([
      firstDroneExtraction(),
      secondDroneExtraction(),
      thirdDroneExtraction()
    ]);
    const knowledgeBase = await createActiveDroneKnowledgeBase({ repos, llm });
    const createdUpdate = repos.listKnowledgeUpdates()[0];

    const third = await processThirdDroneMeeting({ repos, llm });
    const appendRequest = repos
      .listConfirmationRequests()
      .find((request) => request.request_type === "append_meeting");
    expect(appendRequest).toBeTruthy();
    expect(third.topic_match.suggested_action).toBe("ask_append");
    expect(repos.listKnowledgeUpdates()).toHaveLength(1);
    expect(repos.getMeeting(third.meeting_id)).toMatchObject({
      matched_kb_id: knowledgeBase.id,
      archive_status: "suggested"
    });

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, sqlitePath: ":memory:" }),
      id: appendRequest!.id
    });

    const updates = repos.listKnowledgeUpdates();
    const appendedUpdate = updates.find((update) => update.update_type === "meeting_added");
    expect(updates).toHaveLength(2);
    expect(createdUpdate.after_text).toContain("无人机操作方案初步访谈");
    expect(createdUpdate.after_text).toContain("无人机操作员访谈");
    expect(appendedUpdate).toBeTruthy();
    expect(appendedUpdate).toMatchObject({
      kb_id: knowledgeBase.id,
      source_ids_json: JSON.stringify([third.meeting_id])
    });
    expect(appendedUpdate!.after_text).toContain("## 会议摘要");
    expect(appendedUpdate!.after_text).toContain("## 关键结论");
    expect(appendedUpdate!.after_text).toContain("试飞前必须完成场地权限");
    expect(appendedUpdate!.after_text).toContain("## 风险、问题与待验证假设");
    expect(appendedUpdate!.after_text).toContain("试飞权限尚未确认会阻塞试飞排期");
    expect(appendedUpdate!.after_text).toContain("## 待办索引");
    expect(appendedUpdate!.after_text).toContain("确认试飞权限");
    expect(appendedUpdate!.after_text).toContain("## 日程索引");
    expect(appendedUpdate!.after_text).toContain("无人机试飞前检查会议");
    expect(appendedUpdate!.after_text).toContain("## 会议转写记录引用");
    expect(appendedUpdate!.after_text).toContain(`会议 ${third.meeting_id}`);
    expect(repos.getMeeting(third.meeting_id)).toMatchObject({
      matched_kb_id: knowledgeBase.id,
      archive_status: "archived"
    });
    expect(JSON.parse(repos.listKnowledgeBases()[0].created_from_meetings_json)).toEqual(
      expect.arrayContaining([third.meeting_id])
    );
    expect(repos.getConfirmationRequest(appendRequest!.id)?.status).toBe("executed");
  });

  it("marks the current meeting rejected when append_meeting is rejected", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([
      firstDroneExtraction(),
      secondDroneExtraction(),
      thirdDroneExtraction()
    ]);
    const knowledgeBase = await createActiveDroneKnowledgeBase({ repos, llm });
    const third = await processThirdDroneMeeting({ repos, llm });
    const appendRequest = repos
      .listConfirmationRequests()
      .find((request) => request.request_type === "append_meeting");
    expect(appendRequest).toBeTruthy();

    rejectRequest({
      repos,
      id: appendRequest!.id,
      reason: "这场会先不归档"
    });

    expect(repos.listKnowledgeUpdates()).toHaveLength(1);
    expect(repos.getMeeting(third.meeting_id)).toMatchObject({
      matched_kb_id: knowledgeBase.id,
      archive_status: "rejected"
    });
    expect(repos.getConfirmationRequest(appendRequest!.id)).toMatchObject({
      status: "rejected",
      error: "这场会先不归档"
    });
  });
});
