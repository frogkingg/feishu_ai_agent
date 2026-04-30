import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LlmClient, GenerateJsonInput } from "./llmClient";

function loadFixtureJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

const DroneRiskReviewExtraction = {
  meeting_summary:
    "本次会议继续围绕无人机操作方案风险评审，明确试飞权限、现场安全员和电池状态检查仍需跟进。",
  key_decisions: [
    {
      decision: "试飞前必须完成场地权限、现场安全员和电池状态三项检查。",
      evidence: "试飞前必须确认场地权限、现场安全员和电池状态。"
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
  ],
  topic_keywords: ["无人机", "操作流程", "试飞权限", "风险控制"],
  risks: [
    {
      risk: "试飞权限尚未确认会阻塞试飞排期。",
      evidence: "会议强调试飞前必须确认场地权限。"
    }
  ],
  source_mentions: [
    {
      type: "doc",
      name_or_keyword: "无人机安全规范",
      reason: "会议中提到上次的无人机安全规范仍要继续参考。"
    }
  ],
  confidence: 0.86
};

export class MockLlmClient implements LlmClient {
  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    if (input.schemaName !== "MeetingExtractionResult") {
      throw new Error(`MockLlmClient does not support schema: ${input.schemaName}`);
    }

    if (input.userPrompt.includes("无人机操作方案初步访谈")) {
      return loadFixtureJson<T>("fixtures/expected/drone_interview_01.extraction.json");
    }

    if (input.userPrompt.includes("无人机操作员访谈")) {
      return loadFixtureJson<T>("fixtures/expected/drone_interview_02.extraction.json");
    }

    if (input.userPrompt.includes("无人机实施风险评审")) {
      return DroneRiskReviewExtraction as T;
    }

    return {
      meeting_summary: "Mock LLM 未匹配到 fixture，仅返回空抽取结果。",
      key_decisions: [],
      action_items: [],
      calendar_drafts: [],
      topic_keywords: [],
      risks: [],
      source_mentions: [],
      confidence: 0.3
    } as T;
  }
}
