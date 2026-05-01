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
    title: "飞书 AI 校园挑战赛",
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
    meeting_summary: "本次会议同步了飞书 AI 校园挑战赛的复赛安排和提交要求。",
    key_decisions: [],
    action_items: [],
    calendar_drafts: [],
    topic_keywords: ["飞书 AI 校园挑战赛"],
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
            title: "复赛作品提交截止",
            start_time: "2026-05-07T12:00:00+08:00",
            end_time: null,
            duration_minutes: 15,
            participants: ["参赛同学"],
            agenda: "提醒复赛作品提交截止。",
            location: null,
            evidence: "复赛作品提交截止时间为 5 月 7 日中午 12 点。",
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

    expect(extraction.calendar_drafts[0].title).toBe("复赛作品提交截止同步");
    expect(llm.calls).toHaveLength(1);
  });

  it("keeps calendar titles that already include an intent word", async () => {
    const llm = new SequenceLlmClient([
      validExtraction({
        calendar_drafts: [
          {
            title: "决赛路演评审会议",
            start_time: "2026-05-15T14:00:00+08:00",
            end_time: null,
            duration_minutes: 60,
            participants: ["参赛同学"],
            agenda: "进行决赛路演评审。",
            location: null,
            evidence: "决赛时间调整为 5 月 15 日。",
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

    expect(extraction.calendar_drafts[0].title).toBe("决赛路演评审会议");
    expect(llm.calls).toHaveLength(1);
  });
});
