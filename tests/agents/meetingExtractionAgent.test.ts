import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMeetingExtractionAgent } from "../../src/agents/meetingExtractionAgent";
import { MeetingExtractionResult } from "../../src/schemas";
import { GenerateJsonInput, LlmClient } from "../../src/services/llm/llmClient";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { MeetingRow, createRepositories } from "../../src/services/store/repositories";

class SequenceLlmClient implements LlmClient {
  readonly calls: GenerateJsonInput[] = [];

  constructor(private readonly results: unknown[]) {}

  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    this.calls.push(input);
    const next = this.results.shift();
    if (next === undefined) {
      throw new Error("SequenceLlmClient exhausted");
    }

    return next as T;
  }
}

function createMeeting(transcriptText = "会议转写内容"): MeetingRow {
  const repos = createRepositories(createMemoryDatabase());
  return repos.createMeeting({
    id: "mtg_agent_test",
    external_meeting_id: null,
    title: "产品发布评审会",
    started_at: "2026-04-29T19:00:00+08:00",
    ended_at: "2026-04-29T20:00:00+08:00",
    organizer: "Henry",
    participants_json: JSON.stringify(["Henry"]),
    minutes_url: null,
    transcript_url: null,
    transcript_text: transcriptText,
    summary: null,
    keywords_json: JSON.stringify([]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 0,
    calendar_count: 0
  });
}

function validExtraction(
  overrides: Partial<MeetingExtractionResult> = {}
): MeetingExtractionResult {
  return {
    meeting_summary: "本次会议同步了产品发布计划、评审安排和项目里程碑。",
    key_decisions: [],
    action_items: [],
    calendar_drafts: [],
    topic_keywords: ["产品发布", "评审安排", "项目里程碑"],
    risks: [],
    source_mentions: [],
    confidence: 0.86,
    ...overrides
  };
}

describe("MeetingExtractionAgent", () => {
  it("validates Mock LLM output with MeetingExtractionResult schema", async () => {
    const transcript = readFileSync(
      join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
      "utf8"
    );
    const repos = createRepositories(createMemoryDatabase());
    const meeting = repos.createMeeting({
      id: "mtg_agent_001",
      external_meeting_id: null,
      title: "无人机操作方案初步访谈",
      started_at: "2026-04-28T10:00:00+08:00",
      ended_at: "2026-04-28T11:00:00+08:00",
      organizer: "张三",
      participants_json: JSON.stringify(["张三", "李四"]),
      minutes_url: null,
      transcript_url: null,
      transcript_text: transcript,
      summary: null,
      keywords_json: JSON.stringify([]),
      matched_kb_id: null,
      match_score: null,
      archive_status: "not_archived",
      action_count: 0,
      calendar_count: 0
    });

    const extraction = await runMeetingExtractionAgent({
      meeting,
      llm: new MockLlmClient()
    });

    expect(extraction.confidence).toBeGreaterThan(0.8);
    expect(extraction.key_decisions[0].decision).toContain("先调研");
  });

  it("unwraps a single-object array before validating the extraction", async () => {
    const expected = validExtraction({
      meeting_summary: "模型把合法对象包在单元素数组里返回。"
    });
    const llm = new SequenceLlmClient([[expected]]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting(),
      llm
    });

    expect(extraction.meeting_summary).toBe(expected.meeting_summary);
    expect(llm.calls).toHaveLength(1);
  });

  it("selects the first extraction-like object from a non-empty top-level array", async () => {
    const expected = validExtraction({
      meeting_summary: "模型把对象放在多元素数组里返回。"
    });
    const llm = new SequenceLlmClient([["说明文本", expected]]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting(),
      llm
    });

    expect(extraction.meeting_summary).toBe(expected.meeting_summary);
    expect(llm.calls).toHaveLength(1);
  });

  it("repairs invalid top-level arrays through the LLM once deterministic normalization fails", async () => {
    const repaired = validExtraction({
      meeting_summary: "修复后返回顶层对象。"
    });
    const llm = new SequenceLlmClient([[], repaired]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting(),
      llm
    });

    expect(extraction.meeting_summary).toBe(repaired.meeting_summary);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].userPrompt).toContain("不要返回 array 作为顶层");
  });

  it("normalizes explicit schedule titles that lack calendar intent words", async () => {
    const llm = new SequenceLlmClient([
      validExtraction({
        calendar_drafts: [
          {
            title: "需求冻结截止",
            start_time: "2026-05-07T12:00:00+08:00",
            end_time: null,
            duration_minutes: 15,
            participants: ["产品经理", "研发负责人"],
            agenda: "提醒需求冻结截止。",
            location: null,
            evidence: "需求冻结截止时间为 5 月 7 日中午 12 点。",
            confidence: 0.82,
            missing_fields: ["end_time", "location"]
          }
        ]
      })
    ]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting(),
      llm
    });

    expect(extraction.calendar_drafts[0].title).toBe("需求冻结截止提醒同步");
    expect(llm.calls).toHaveLength(1);
  });

  it("adds a generic review suffix when evidence shows a review schedule", async () => {
    const llm = new SequenceLlmClient([
      validExtraction({
        calendar_drafts: [
          {
            title: "移动端原型",
            start_time: "2026-05-08T15:00:00+08:00",
            end_time: null,
            duration_minutes: 45,
            participants: ["设计", "产品", "研发"],
            agenda: "评审移动端原型和交互风险。",
            location: null,
            evidence: "周五 15 点安排移动端原型评审。",
            confidence: 0.88,
            missing_fields: ["end_time", "location"]
          }
        ]
      })
    ]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting(),
      llm
    });

    expect(extraction.calendar_drafts[0].title).toBe("移动端原型评审");
    expect(llm.calls).toHaveLength(1);
  });

  it("keeps calendar titles that already include an intent word", async () => {
    const llm = new SequenceLlmClient([
      validExtraction({
        calendar_drafts: [
          {
            title: "客户访谈复盘会议",
            start_time: "2026-05-15T14:00:00+08:00",
            end_time: null,
            duration_minutes: 60,
            participants: ["销售", "产品"],
            agenda: "复盘客户访谈结论。",
            location: null,
            evidence: "5 月 15 日下午安排客户访谈复盘会议。",
            confidence: 0.86,
            missing_fields: ["end_time", "location"]
          }
        ]
      })
    ]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting(),
      llm
    });

    expect(extraction.calendar_drafts[0].title).toBe("客户访谈复盘会议");
    expect(llm.calls).toHaveLength(1);
  });

  it("normalizes relative due dates and calendar times against meeting start time", async () => {
    const llm = new SequenceLlmClient([
      validExtraction({
        action_items: [
          {
            title: "更新发布检查清单",
            description: "补齐发布前检查项。",
            owner: "陈一",
            collaborators: [],
            due_date: null,
            priority: "P1",
            evidence: "陈一：我明天前更新发布检查清单。",
            confidence: 0.9,
            suggested_reason: "会议中陈一主动承诺更新发布检查清单。",
            missing_fields: ["due_date"]
          },
          {
            title: "补充回归风险列表",
            description: "补充回归测试风险。",
            owner: "周宁",
            collaborators: [],
            due_date: null,
            priority: "P1",
            evidence: "周宁：后天我把回归风险列表补上。",
            confidence: 0.9,
            suggested_reason: "会议中周宁主动承诺补充回归风险列表。",
            missing_fields: ["due_date"]
          }
        ],
        calendar_drafts: [
          {
            title: "移动端原型",
            start_time: "2026-04-29T15:00:00+08:00",
            end_time: null,
            duration_minutes: 30,
            participants: ["设计", "产品"],
            agenda: "评审移动端原型。",
            location: null,
            evidence: "下周五下午 3 点安排移动端原型评审。",
            confidence: 0.88,
            missing_fields: ["end_time", "location"]
          }
        ]
      })
    ]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting(
        "陈一：我明天前更新发布检查清单。周宁：后天我把回归风险列表补上。下周五下午 3 点安排移动端原型评审。"
      ),
      llm
    });

    expect(extraction.action_items[0]).toMatchObject({
      owner: "陈一",
      due_date: "2026-04-30",
      missing_fields: []
    });
    expect(extraction.action_items[1]).toMatchObject({
      owner: "周宁",
      due_date: "2026-05-01",
      missing_fields: []
    });
    expect(extraction.calendar_drafts[0]).toMatchObject({
      title: "移动端原型评审",
      start_time: "2026-05-08T15:00:00+08:00",
      end_time: "2026-05-08T15:30:00+08:00"
    });
  });

  it("keeps calendar start time missing when evidence has date but no concrete hour", async () => {
    const llm = new SequenceLlmClient([
      validExtraction({
        calendar_drafts: [
          {
            title: "接口对齐沟通",
            start_time: "2026-05-08T10:00:00+08:00",
            end_time: null,
            duration_minutes: null,
            participants: ["项目负责人", "服务端"],
            agenda: "对齐接口状态。",
            location: null,
            evidence: "下周五安排接口对齐沟通，具体几点待定。",
            confidence: 0.82,
            missing_fields: []
          }
        ]
      })
    ]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting("下周五安排接口对齐沟通，具体几点待定。"),
      llm
    });

    expect(extraction.calendar_drafts[0]).toMatchObject({
      start_time: null,
      end_time: null,
      missing_fields: ["start_time"]
    });
  });

  it("does not assign the organizer or card recipient as action owner without meeting evidence", async () => {
    const llm = new SequenceLlmClient([
      validExtraction({
        action_items: [
          {
            title: "整理发布清单",
            description: "把发布前检查项整理成清单。",
            owner: "Henry",
            collaborators: [],
            due_date: "2026-05-10",
            priority: "P1",
            evidence: "会议中提出需要整理发布前检查清单。",
            confidence: 0.8,
            suggested_reason: "组织者 Henry 默认负责，用户据此认领完成。",
            missing_fields: []
          }
        ]
      })
    ]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting("会议中提出需要整理发布前检查清单。"),
      llm
    });

    expect(extraction.action_items[0]).toMatchObject({
      owner: null,
      missing_fields: expect.arrayContaining(["owner"]),
      suggested_reason: "会议证据中未明确负责人，需确认后再创建待办。"
    });
  });

  it("keeps explicitly named action owners when evidence supports the assignment", async () => {
    const llm = new SequenceLlmClient([
      validExtraction({
        action_items: [
          {
            title: "修改首页线框图",
            description: "按评审结论更新首页线框图。",
            owner: "陈一",
            collaborators: [],
            due_date: "2026-05-06",
            priority: "P1",
            evidence: "陈一：我负责在 2026-05-06 前把首页线框图改一版。",
            confidence: 0.92,
            suggested_reason: "会议中陈一明确负责修改首页线框图，并给出截止日期。",
            missing_fields: []
          }
        ]
      })
    ]);

    const extraction = await runMeetingExtractionAgent({
      meeting: createMeeting("陈一：我负责在 2026-05-06 前把首页线框图改一版。"),
      llm
    });

    expect(extraction.action_items[0]).toMatchObject({
      owner: "陈一",
      missing_fields: []
    });
  });

  it("does not keep domain-specific challenge terms in production extraction logic", () => {
    const sourcePath = join(process.cwd(), "src/agents/meetingExtractionAgent.ts");
    const source = readFileSync(sourcePath, "utf8");
    const blockedTerms = [
      "比赛",
      "校园",
      "飞书 AI",
      "复赛",
      "决赛",
      "路演",
      "GitHub public",
      "阶段成果",
      "豆包",
      "Openclaw",
      "评分标准",
      "参赛"
    ];

    for (const term of blockedTerms) {
      expect(source).not.toContain(term);
    }
  });
});
