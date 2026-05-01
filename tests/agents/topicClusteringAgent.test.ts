import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { MeetingExtractionResult } from "../../src/schemas";
import { confirmRequest } from "../../src/services/confirmationService";
import { LlmClient } from "../../src/services/llm/llmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

function readFixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures/meetings", name), "utf8");
}

function readEvaluationFixture(name: string): string {
  return readFileSync(join(process.cwd(), "evaluation/fixtures/meetings", name), "utf8");
}

function readExpected(name: string): MeetingExtractionResult {
  return JSON.parse(
    readFileSync(join(process.cwd(), "fixtures/expected", name), "utf8")
  ) as MeetingExtractionResult;
}

function readEvaluationExtraction(name: string): MeetingExtractionResult {
  return JSON.parse(
    readFileSync(join(process.cwd(), "evaluation/fixtures/extractions", name), "utf8")
  ) as MeetingExtractionResult;
}

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
      "本次风险评审继续围绕无人机操作方案，确认试飞权限、现场安全员和电池状态仍是后续推进重点。",
    topic_keywords: ["无人机", "操作流程", "试飞权限", "风险控制"],
    key_decisions: [
      {
        decision: "后续试飞前必须先确认场地权限和现场安全员。",
        evidence: "试飞权限和现场安全员仍是推进重点。"
      }
    ],
    risks: [
      {
        risk: "试飞权限尚未确认可能影响排期。",
        evidence: "会议继续强调试飞权限。"
      }
    ]
  };
}

function firstProductReviewExtraction(): MeetingExtractionResult {
  return readEvaluationExtraction("product_review_01.extraction.json");
}

function secondProductReviewExtraction(): MeetingExtractionResult {
  return readEvaluationExtraction("product_review_02.extraction.json");
}

function productReviewExtractionWithKeywords(keywords: string[]): MeetingExtractionResult {
  return {
    ...firstProductReviewExtraction(),
    topic_keywords: keywords
  };
}

function firstProductReviewExtractionWithInferredKbAction(): MeetingExtractionResult {
  const extraction = firstProductReviewExtraction();
  return {
    ...extraction,
    action_items: [
      ...extraction.action_items,
      {
        title: "创建产品评审知识库",
        description: "把产品原型评审内容整理为知识库。",
        owner: null,
        collaborators: [],
        due_date: null,
        priority: "P2",
        evidence: "会议提到知识库入口。",
        confidence: 0.55,
        suggested_reason: "模型从知识库入口推断需要创建知识库。",
        missing_fields: ["owner", "due_date"]
      }
    ]
  };
}

async function processFirstDroneMeeting(
  repos: ReturnType<typeof createRepositories>,
  llm: LlmClient
) {
  return processMeetingWorkflow({
    repos,
    llm,
    meeting: {
      title: "无人机操作方案真实 LLM 测试",
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
  transcriptText?: string;
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
      transcript_text: input.transcriptText ?? readFixture("drone_interview_02.txt")
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

async function processFirstProductReviewMeeting(
  repos: ReturnType<typeof createRepositories>,
  llm: LlmClient
) {
  return processMeetingWorkflow({
    repos,
    llm,
    meeting: {
      title: "产品原型评审会",
      participants: ["刘敏", "陈一", "Henry"],
      organizer: "刘敏",
      started_at: "2026-04-30T14:00:00+08:00",
      ended_at: "2026-04-30T15:00:00+08:00",
      transcript_text: readEvaluationFixture("product_review_01.txt")
    }
  });
}

async function processSecondProductReviewMeeting(
  repos: ReturnType<typeof createRepositories>,
  llm: LlmClient
) {
  return processMeetingWorkflow({
    repos,
    llm,
    meeting: {
      title: "产品原型复盘同步",
      participants: ["刘敏", "陈一", "周宁", "Henry"],
      organizer: "刘敏",
      started_at: "2026-05-02T16:00:00+08:00",
      ended_at: "2026-05-02T16:45:00+08:00",
      transcript_text: readEvaluationFixture("product_review_02.txt")
    }
  });
}

async function processEvaluationMeeting(
  repos: ReturnType<typeof createRepositories>,
  llm: LlmClient,
  meeting: {
    title: string;
    participants: string[];
    organizer: string;
    started_at: string;
    ended_at: string;
    fixtureName: string;
  }
) {
  return processMeetingWorkflow({
    repos,
    llm,
    meeting: {
      title: meeting.title,
      participants: meeting.participants,
      organizer: meeting.organizer,
      started_at: meeting.started_at,
      ended_at: meeting.ended_at,
      transcript_text: readEvaluationFixture(meeting.fixtureName)
    }
  });
}

async function processManualTopicMeeting(input: {
  repos: ReturnType<typeof createRepositories>;
  llm: LlmClient;
  title: string;
  participants: string[];
  organizer: string;
  started_at: string;
  ended_at: string;
  transcript_text: string;
}) {
  return processMeetingWorkflow({
    repos: input.repos,
    llm: input.llm,
    meeting: {
      title: input.title,
      participants: input.participants,
      organizer: input.organizer,
      started_at: input.started_at,
      ended_at: input.ended_at,
      transcript_text: input.transcript_text
    }
  });
}

describe("TopicClusteringAgent", () => {
  it("observes the first drone meeting and creates a KB confirmation after the second related meeting", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([firstDroneExtraction(), secondDroneExtraction()]);

    const first = await processFirstDroneMeeting(repos, llm);

    expect(first.topic_match.suggested_action).toBe("observe");
    expect(
      repos.listConfirmationRequests().some((request) => request.request_type === "create_kb")
    ).toBe(false);

    const second = await processSecondDroneMeeting({ repos, llm });

    const createKbRequests = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "create_kb");

    expect(second.topic_match.suggested_action).toBe("ask_create");
    expect(second.topic_match.score).toBeGreaterThanOrEqual(0.78);
    expect(second.topic_match.candidate_meeting_ids).toEqual(
      expect.arrayContaining([first.meeting_id, second.meeting_id])
    );
    expect(createKbRequests).toHaveLength(1);
    expect(second.confirmation_requests).toContain(createKbRequests[0].id);
    expect(JSON.parse(createKbRequests[0].original_payload_json)).toMatchObject({
      topic_name: "无人机操作流程主题知识库",
      suggested_goal: expect.stringContaining("无人机操作流程主题知识库"),
      candidate_meeting_ids: second.topic_match.candidate_meeting_ids,
      meeting_ids: second.topic_match.candidate_meeting_ids,
      match_reasons: second.topic_match.match_reasons,
      score: second.topic_match.score,
      default_structure: [
        "00 README / 项目总览",
        "01 Project Board / 进度与待办",
        "02 Timeline / 里程碑与甘特",
        "03 Meetings / 会议记录",
        "04 Docs & Resources / 文档与资料",
        "05 Decisions & Risks / 决策与风险",
        "06 Calendar / 日程索引"
      ],
      card_preview: {
        card_type: "create_kb_confirmation",
        request_id: createKbRequests[0].id,
        actions: [
          expect.objectContaining({ key: "create_kb" }),
          expect.objectContaining({ key: "edit_and_create" }),
          expect.objectContaining({ key: "append_current_only" }),
          expect.objectContaining({ key: "reject" }),
          expect.objectContaining({ key: "never_remind_topic" })
        ]
      }
    });
  });

  it("raises score and reasons when the current meeting explicitly asks to organize a knowledge base", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([firstDroneExtraction(), secondDroneExtraction()]);

    const first = await processFirstDroneMeeting(repos, llm);
    const explicitTranscript = [
      "继续讨论无人机操作方案。",
      "操作流程不统一，试飞前权限确认分散。",
      "需要建立统一无人机操作 SOP，并补充风险控制清单。",
      "王五负责在 2026-05-03 前整理风险清单。",
      "后续要把这两次访谈整理成一个无人机操作方案知识库。"
    ].join("\n");

    const second = await processSecondDroneMeeting({
      repos,
      llm,
      transcriptText: explicitTranscript
    });

    expect(second.topic_match.suggested_action).toBe("ask_create");
    expect(second.topic_match.score).toBeGreaterThanOrEqual(0.9);
    expect(second.topic_match.candidate_meeting_ids).toEqual(
      expect.arrayContaining([first.meeting_id, second.meeting_id])
    );
    expect(second.topic_match.match_reasons).toContain("当前会议显式提出整理成知识库");
  });

  it("asks to append a third related meeting to the existing active knowledge base", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([
      firstDroneExtraction(),
      secondDroneExtraction(),
      thirdDroneExtraction()
    ]);

    await processFirstDroneMeeting(repos, llm);
    await processSecondDroneMeeting({ repos, llm });
    const createKbRequest = repos
      .listConfirmationRequests()
      .find((request) => request.request_type === "create_kb");
    expect(createKbRequest).toBeTruthy();

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, sqlitePath: ":memory:" }),
      id: createKbRequest!.id
    });

    const third = await processThirdDroneMeeting({ repos, llm });
    const appendRequests = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "append_meeting");
    const createKbRequests = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "create_kb");

    expect(third.topic_match.suggested_action).toBe("ask_append");
    expect(third.topic_match.matched_kb_id).toBe(repos.listKnowledgeBases()[0].id);
    expect(appendRequests).toHaveLength(1);
    expect(createKbRequests).toHaveLength(1);
    expect(third.confirmation_requests).toContain(appendRequests[0].id);
    expect(JSON.parse(appendRequests[0].original_payload_json)).toMatchObject({
      kb_id: repos.listKnowledgeBases()[0].id,
      meeting_id: third.meeting_id,
      meeting_summary: expect.stringContaining("风险评审继续围绕无人机操作方案"),
      reason: expect.stringContaining("建议确认后追加到知识库")
    });
  });

  it("does not treat model-inferred knowledge base actions as explicit first-meeting intent", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([
      firstDroneExtraction(),
      secondDroneExtraction(),
      firstProductReviewExtractionWithInferredKbAction()
    ]);

    await processFirstDroneMeeting(repos, llm);
    await processSecondDroneMeeting({ repos, llm });
    const createKbRequestsBefore = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "create_kb");

    const productReview = await processFirstProductReviewMeeting(repos, llm);
    const createKbRequestsAfter = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "create_kb");

    expect(productReview.topic_match.suggested_action).toBe("observe");
    expect(createKbRequestsAfter).toHaveLength(createKbRequestsBefore.length);
  });

  it("keeps the first product review in observe and asks to create after a second related review", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([
      firstProductReviewExtraction(),
      secondProductReviewExtraction()
    ]);

    expect(readEvaluationFixture("product_review_01.txt")).not.toContain("无人机");
    expect(readEvaluationFixture("product_review_02.txt")).not.toContain("无人机");

    const first = await processFirstProductReviewMeeting(repos, llm);
    expect(first.topic_match.suggested_action).toBe("observe");

    const second = await processSecondProductReviewMeeting(repos, llm);

    expect(second.topic_match.suggested_action).toBe("ask_create");
    expect(second.topic_match.candidate_meeting_ids).toEqual(
      expect.arrayContaining([first.meeting_id, second.meeting_id])
    );
    expect(second.topic_match.match_reasons).toEqual(
      expect.arrayContaining(["发现至少一场强相关历史会议"])
    );
  });

  it("observes the first product review meeting with only generic topic fallback", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([
      productReviewExtractionWithKeywords(["产品原型", "交互流程", "首页信息架构"])
    ]);

    const result = await processFirstProductReviewMeeting(repos, llm);

    expect(result.topic_match.suggested_action).toBe("observe");
    expect(result.topic_match.candidate_meeting_ids).toEqual([result.meeting_id]);
    expect(
      repos.listConfirmationRequests().some((request) => request.request_type === "create_kb")
    ).toBe(false);
  });

  it("asks to create a product review knowledge base after a second strongly related meeting without explicit knowledge-base intent", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([
      productReviewExtractionWithKeywords(["产品原型", "交互流程", "首页信息架构"]),
      {
        ...secondProductReviewExtraction(),
        topic_keywords: ["产品原型", "交互流程", "首页信息架构", "确认卡片"]
      }
    ]);

    const first = await processFirstProductReviewMeeting(repos, llm);
    const second = await processSecondProductReviewMeeting(repos, llm);

    expect(second.topic_match.suggested_action).toBe("ask_create");
    expect(second.topic_match.match_reasons).not.toContain("当前会议显式提出整理成知识库");
    expect(second.topic_match.candidate_meeting_ids).toHaveLength(2);
    expect(second.topic_match.candidate_meeting_ids).toEqual(
      expect.arrayContaining([first.meeting_id, second.meeting_id])
    );
  });

  it("asks to create from explicit non-drone knowledge-base intent on the first meeting", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([
      {
        ...productReviewExtractionWithKeywords(["用户访谈", "产品原型评审", "信息架构"]),
        meeting_summary: "用户访谈复盘决定把访谈内容整理为产品原型评审知识库。"
      }
    ]);

    const result = await processManualTopicMeeting({
      repos,
      llm,
      title: "用户访谈复盘会",
      participants: ["刘敏", "陈一", "Henry"],
      organizer: "刘敏",
      started_at: "2026-05-06T14:00:00+08:00",
      ended_at: "2026-05-06T15:00:00+08:00",
      transcript_text: [
        "刘敏：这次先复盘两轮用户访谈里提到的产品原型问题。",
        "陈一：首页信息架构和交互流程都需要沉淀下来，方便后续评审继续追。",
        "Henry：把这两次用户访谈整理成一个产品原型评审知识库，作为后续资料入口。"
      ].join("\n")
    });

    expect(result.topic_match.suggested_action).toBe("ask_create");
    expect(result.topic_match.candidate_meeting_ids).toEqual([result.meeting_id]);
    expect(result.topic_match.match_reasons).toContain("当前会议显式提出整理成知识库");
  });

  it("observes a first campus roadshow prep meeting with generic topic keywords only", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const extraction = readEvaluationExtraction("campus_competition_01.extraction.json");
    const llm = new QueueLlmClient([extraction]);

    expect(extraction.topic_keywords.length).toBeGreaterThan(0);
    expect(readEvaluationFixture("campus_competition_01.txt")).not.toContain("无人机");

    const result = await processManualTopicMeeting({
      repos,
      llm,
      title: "校园比赛路演准备会议",
      participants: ["Henry", "孙同学", "赵同学"],
      organizer: "Henry",
      started_at: "2026-05-03T19:00:00+08:00",
      ended_at: "2026-05-03T20:00:00+08:00",
      transcript_text: readEvaluationFixture("campus_competition_01.txt")
    });

    expect(result.topic_match.suggested_action).toBe("observe");
    expect(result.topic_match.candidate_meeting_ids).toEqual([result.meeting_id]);
    expect(
      repos.listConfirmationRequests().some((request) => request.request_type === "create_kb")
    ).toBe(false);
  });

  it("keeps a chitchat meeting as no_action", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([
      readEvaluationExtraction("no_action_chitchat_01.extraction.json")
    ]);

    const result = await processEvaluationMeeting(repos, llm, {
      title: "午后闲聊",
      participants: ["Henry", "小林"],
      organizer: "Henry",
      started_at: "2026-05-04T13:00:00+08:00",
      ended_at: "2026-05-04T13:20:00+08:00",
      fixtureName: "no_action_chitchat_01.txt"
    });

    expect(result.topic_match.suggested_action).toBe("no_action");
    expect(result.confirmation_requests).toEqual([]);
  });

  it("does not contain source-level drone-specific topic fallback logic", () => {
    const source = readFileSync(join(process.cwd(), "src/agents/topicClusteringAgent.ts"), "utf8");

    expect(source).not.toContain("无人机");
    expect(source).not.toContain('currentText.includes("无人机")');
    expect(source).not.toContain("hasCoreDroneTopic");
    expect(source).not.toContain("CoreTopicSignals");
  });

  it.each([
    {
      title: "产品原型评审会",
      participants: ["刘敏", "陈一", "Henry"],
      organizer: "刘敏",
      started_at: "2026-04-30T14:00:00+08:00",
      ended_at: "2026-04-30T15:00:00+08:00",
      fixtureName: "product_review_01.txt",
      extractionName: "product_review_01.extraction.json",
      expectedAction: "observe"
    },
    {
      title: "校园比赛 Demo 冲刺会",
      participants: ["Henry", "孙同学", "赵同学"],
      organizer: "Henry",
      started_at: "2026-05-03T19:00:00+08:00",
      ended_at: "2026-05-03T20:00:00+08:00",
      fixtureName: "campus_competition_01.txt",
      extractionName: "campus_competition_01.extraction.json",
      expectedAction: "observe"
    },
    {
      title: "接口对齐沟通",
      participants: ["Henry", "周宁"],
      organizer: "Henry",
      started_at: "2026-05-04T15:00:00+08:00",
      ended_at: "2026-05-04T15:30:00+08:00",
      fixtureName: "ambiguous_schedule_01.txt",
      extractionName: "ambiguous_schedule_01.extraction.json",
      expectedAction: "observe"
    },
    {
      title: "午后闲聊",
      participants: ["Henry", "小林"],
      organizer: "Henry",
      started_at: "2026-05-04T13:00:00+08:00",
      ended_at: "2026-05-04T13:20:00+08:00",
      fixtureName: "no_action_chitchat_01.txt",
      extractionName: "no_action_chitchat_01.extraction.json",
      expectedAction: "no_action"
    }
  ])(
    "uses generic first-meeting fallback for $title",
    async ({ extractionName, expectedAction, ...meeting }) => {
      const repos = createRepositories(createMemoryDatabase());
      const llm = new QueueLlmClient([readEvaluationExtraction(extractionName)]);

      const result = await processEvaluationMeeting(repos, llm, meeting);

      expect(result.topic_match.suggested_action).toBe(expectedAction);
      expect(
        repos.listConfirmationRequests().some((request) => request.request_type === "create_kb")
      ).toBe(false);
    }
  );
});
