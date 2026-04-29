import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MeetingExtractionResult } from "../../src/schemas";
import { LlmClient } from "../../src/services/llm/llmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

function readFixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures/meetings", name), "utf8");
}

function readExpected(name: string): MeetingExtractionResult {
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures/expected", name), "utf8")) as MeetingExtractionResult;
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

async function processFirstDroneMeeting(repos: ReturnType<typeof createRepositories>, llm: LlmClient) {
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

describe("TopicClusteringAgent", () => {
  it("observes the first drone meeting and creates a KB confirmation after the second related meeting", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new QueueLlmClient([firstDroneExtraction(), secondDroneExtraction()]);

    const first = await processFirstDroneMeeting(repos, llm);

    expect(first.topic_match.suggested_action).toBe("observe");
    expect(repos.listConfirmationRequests().some((request) => request.request_type === "create_kb")).toBe(false);

    const second = await processSecondDroneMeeting({ repos, llm });

    const createKbRequests = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "create_kb");

    expect(second.topic_match.suggested_action).toBe("ask_create");
    expect(second.topic_match.score).toBeGreaterThanOrEqual(0.78);
    expect(second.topic_match.candidate_meeting_ids).toEqual(expect.arrayContaining([first.meeting_id, second.meeting_id]));
    expect(createKbRequests).toHaveLength(1);
    expect(second.confirmation_requests).toContain(createKbRequests[0].id);
    expect(JSON.parse(createKbRequests[0].original_payload_json)).toMatchObject({
      topic_name: "无人机操作方案",
      suggested_goal: expect.stringContaining("无人机操作方案"),
      candidate_meeting_ids: second.topic_match.candidate_meeting_ids,
      meeting_ids: second.topic_match.candidate_meeting_ids,
      match_reasons: second.topic_match.match_reasons,
      score: second.topic_match.score,
      default_structure: expect.arrayContaining(["00 首页 / 总览", "06 单个会议总结"])
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
    expect(second.topic_match.candidate_meeting_ids).toEqual(expect.arrayContaining([first.meeting_id, second.meeting_id]));
    expect(second.topic_match.match_reasons).toContain("当前会议显式提出整理成知识库");
  });
});
