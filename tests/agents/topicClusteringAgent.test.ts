import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { runTopicClusteringAgent } from "../../src/agents/topicClusteringAgent";
import { MeetingExtractionResult, TopicMatchResult } from "../../src/schemas";
import { confirmRequest } from "../../src/services/confirmationService";
import { GenerateJsonInput, LlmClient } from "../../src/services/llm/llmClient";
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
  readonly calls: GenerateJsonInput[] = [];

  constructor(private readonly results: MeetingExtractionResult[]) {}

  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    this.calls.push(input);
    if (input.schemaName === "TopicMatchResult") {
      return defaultTopicDecision(input) as T;
    }
    if (input.schemaName !== "MeetingExtractionResult") {
      throw new Error(`QueueLlmClient does not support schema: ${input.schemaName}`);
    }
    const result = this.results.shift();
    if (!result) {
      throw new Error("QueueLlmClient has no remaining results");
    }
    return result as T;
  }
}

class TopicDecisionLlmClient implements LlmClient {
  readonly calls: GenerateJsonInput[] = [];

  constructor(private readonly decide: (input: GenerateJsonInput) => TopicMatchResult) {}

  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    this.calls.push(input);
    return this.decide(input) as T;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
    : [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item)
      )
    : [];
}

function extractTopicContext(input: GenerateJsonInput): Record<string, unknown> {
  const marker = "topic_clustering_context:";
  const start = input.userPrompt.lastIndexOf(marker);
  if (start < 0) {
    return {};
  }
  return asRecord(JSON.parse(input.userPrompt.slice(start + marker.length).trim()) as unknown);
}

function shared(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function hasExplicitKnowledgeBaseRequest(context: Record<string, unknown>): boolean {
  const current = asRecord(context.current_meeting);
  const extraction = asRecord(context.extraction);
  const text = [current.title, current.transcript_excerpt, extraction.meeting_summary].join(" ");
  return (
    /(?:整理|创建|新建|建立|搭建|沉淀|归档|做成).{0,20}(?:知识库|调研档案|项目资料)/.test(
      text
    ) ||
    /(?:知识库|调研档案|项目资料).{0,20}(?:整理|创建|新建|建立|搭建|沉淀|归档)/.test(
      text
    )
  );
}

function hasTopicEvidence(context: Record<string, unknown>): boolean {
  const extraction = asRecord(context.extraction);
  return (
    stringArray(extraction.topic_keywords).length > 0 ||
    recordArray(extraction.key_decisions).length > 0 ||
    recordArray(extraction.risks).length > 0 ||
    recordArray(extraction.action_items).length > 0 ||
    recordArray(extraction.calendar_drafts).length > 0 ||
    recordArray(extraction.source_mentions).length > 0
  );
}

function defaultTopicDecision(input: GenerateJsonInput): TopicMatchResult {
  const context = extractTopicContext(input);
  const current = asRecord(context.current_meeting);
  const extraction = asRecord(context.extraction);
  const currentMeetingId = stringValue(current.id, "mtg_current");
  const currentKeywords = [
    ...stringArray(current.keywords),
    ...stringArray(extraction.topic_keywords)
  ];
  const currentText = [
    current.title,
    current.summary,
    current.transcript_excerpt,
    extraction.meeting_summary
  ].join(" ");
  const knowledgeBases = recordArray(context.existing_knowledge_bases);
  const matchedKnowledgeBase = knowledgeBases.find(
    (knowledgeBase) =>
      shared(currentKeywords, stringArray(knowledgeBase.related_keywords)).length > 0
  );

  if (matchedKnowledgeBase) {
    return {
      current_meeting_id: currentMeetingId,
      matched_kb_id: stringValue(matchedKnowledgeBase.id, "kb_current"),
      matched_kb_name: stringValue(matchedKnowledgeBase.name, "已有知识库"),
      score: 0.86,
      match_reasons: ["Mock LLM 判断当前会议应追加到已有知识库"],
      suggested_action: "ask_append",
      candidate_meeting_ids: [
        ...stringArray(matchedKnowledgeBase.created_from_meetings),
        currentMeetingId
      ]
    };
  }

  const candidateMeetings = recordArray(context.candidate_meetings);
  const relatedCandidates = candidateMeetings.filter((candidate) => {
    const candidateKeywords = stringArray(candidate.keywords);
    const candidateText = [candidate.title, candidate.summary, candidate.transcript_excerpt].join(
      " "
    );
    return (
      shared(currentKeywords, candidateKeywords).length > 0 ||
      candidateKeywords.some((keyword) => currentText.includes(keyword)) ||
      currentKeywords.some((keyword) => candidateText.includes(keyword))
    );
  });

  if (hasExplicitKnowledgeBaseRequest(context)) {
    return {
      current_meeting_id: currentMeetingId,
      matched_kb_id: null,
      matched_kb_name: null,
      score: 0.92,
      match_reasons: ["当前会议显式提出整理成知识库"],
      suggested_action: "ask_create",
      candidate_meeting_ids: [
        ...relatedCandidates.map((meeting) => stringValue(meeting.id, "")).filter(Boolean),
        currentMeetingId
      ]
    };
  }

  if (relatedCandidates.length > 0) {
    return {
      current_meeting_id: currentMeetingId,
      matched_kb_id: null,
      matched_kb_name: null,
      score: 0.84,
      match_reasons: ["发现至少一场强相关历史会议"],
      suggested_action: "ask_create",
      candidate_meeting_ids: [
        ...relatedCandidates.map((meeting) => stringValue(meeting.id, "")).filter(Boolean),
        currentMeetingId
      ]
    };
  }

  if (hasTopicEvidence(context)) {
    return {
      current_meeting_id: currentMeetingId,
      matched_kb_id: null,
      matched_kb_name: null,
      score: 0.62,
      match_reasons: ["Mock LLM 判断当前会议有主题信号，先观察"],
      suggested_action: "observe",
      candidate_meeting_ids: [currentMeetingId]
    };
  }

  return {
    current_meeting_id: currentMeetingId,
    matched_kb_id: null,
    matched_kb_name: null,
    score: 0.4,
    match_reasons: ["Mock LLM 判断当前会议不需要知识库处理"],
    suggested_action: "no_action",
    candidate_meeting_ids: [currentMeetingId]
  };
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

function createStoredMeeting(
  repos: ReturnType<typeof createRepositories>,
  overrides: {
    id: string;
    title: string;
    summary?: string | null;
    keywords?: string[];
    transcriptText?: string;
    archiveStatus?: "not_archived" | "suggested" | "archived" | "rejected";
    matchedKbId?: string | null;
  }
) {
  return repos.createMeeting({
    id: overrides.id,
    external_meeting_id: null,
    title: overrides.title,
    started_at: "2026-05-06T10:00:00+08:00",
    ended_at: "2026-05-06T11:00:00+08:00",
    organizer: "Henry",
    participants_json: JSON.stringify(["Henry", "刘敏"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: overrides.transcriptText ?? "会议内容由测试 LLM 判断语义关系。",
    summary: overrides.summary ?? "会议摘要由测试 LLM 判断语义关系。",
    keywords_json: JSON.stringify(overrides.keywords ?? []),
    matched_kb_id: overrides.matchedKbId ?? null,
    match_score: null,
    archive_status: overrides.archiveStatus ?? "not_archived",
    action_count: 0,
    calendar_count: 0
  });
}

describe("TopicClusteringAgent", () => {
  it("uses LLM ask_create even when title and keyword overlap are weak", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const historical = createStoredMeeting(repos, {
      id: "mtg_history_weak_signal",
      title: "周会记录",
      keywords: ["完全不同"],
      summary: "这场会讨论了访谈样本、用户路径和材料沉淀，但标题没有暴露主题。"
    });
    const current = createStoredMeeting(repos, {
      id: "mtg_current_weak_signal",
      title: "例行同步",
      keywords: ["零散标签"],
      summary: "这场会继续讨论同一批访谈样本和用户路径整理。"
    });
    const llm = new TopicDecisionLlmClient((input) => {
      const context = extractTopicContext(input);
      expect(recordArray(context.candidate_meetings).map((meeting) => meeting.id)).toContain(
        historical.id
      );
      return {
        current_meeting_id: current.id,
        matched_kb_id: null,
        matched_kb_name: null,
        score: 0.88,
        match_reasons: ["LLM 根据会议摘要判断两场弱标题会议属于同一访谈沉淀主题"],
        suggested_action: "ask_create",
        candidate_meeting_ids: [historical.id, current.id]
      };
    });

    const result = await runTopicClusteringAgent({
      repos,
      meeting: current,
      extraction: productReviewExtractionWithKeywords(["零散标签"]),
      llm
    });

    expect(result.suggested_action).toBe("ask_create");
    expect(result.candidate_meeting_ids).toEqual([historical.id, current.id]);
    expect(llm.calls[0].userPrompt).toContain("topic_clustering_context");
  });

  it("uses LLM ask_append even when the existing KB has no keyword match", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const source = createStoredMeeting(repos, {
      id: "mtg_existing_source",
      title: "访谈资料整理",
      keywords: ["旧标签"],
      archiveStatus: "archived"
    });
    const current = createStoredMeeting(repos, {
      id: "mtg_append_weak_signal",
      title: "复盘会",
      keywords: ["新标签"],
      summary: "这场会补充了同一知识库的后续事实，但没有复用旧关键词。"
    });
    const knowledgeBase = repos.createKnowledgeBase({
      id: "kb_existing_weak_signal",
      name: "用户访谈沉淀",
      goal: "沉淀访谈事实和后续分析。",
      description: "测试已有知识库。",
      owner: "Henry",
      status: "active",
      confidence_origin: 0.9,
      wiki_url: "mock://feishu/wiki/kb_existing_weak_signal",
      homepage_url: "mock://feishu/wiki/kb_existing_weak_signal/00-home",
      related_keywords_json: JSON.stringify(["旧标签"]),
      created_from_meetings_json: JSON.stringify([source.id]),
      auto_append_policy: "ask_every_time"
    });
    const llm = new TopicDecisionLlmClient(() => ({
      current_meeting_id: current.id,
      matched_kb_id: knowledgeBase.id,
      matched_kb_name: knowledgeBase.name,
      score: 0.87,
      match_reasons: ["LLM 根据摘要判断这场复盘应追加到已有访谈知识库"],
      suggested_action: "ask_append",
      candidate_meeting_ids: [source.id, current.id]
    }));

    const result = await runTopicClusteringAgent({
      repos,
      meeting: current,
      extraction: productReviewExtractionWithKeywords(["新标签"]),
      llm
    });

    expect(result.suggested_action).toBe("ask_append");
    expect(result.matched_kb_id).toBe(knowledgeBase.id);
    expect(result.candidate_meeting_ids).toEqual([source.id, current.id]);
  });

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
      curation_guidance: expect.arrayContaining([
        expect.stringContaining("Knowledge Curator LLM"),
        expect.stringContaining("代码只提供会议摘要"),
        expect.stringContaining("Dashboard 与 Archive")
      ]),
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
    expect(source).not.toContain("titleScore");
    expect(source).not.toContain("keywordScore");
    expect(source).not.toContain("participantScore");
    expect(source).not.toContain("sourceScore");
    expect(source).not.toContain("weighted");
    expect(source).not.toContain("overlapRatio");
    expect(source).not.toContain("GenericTopicSignals");
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
