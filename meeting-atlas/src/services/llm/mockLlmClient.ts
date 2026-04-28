import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LlmClient, GenerateJsonInput } from "./llmClient";

function loadFixtureJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

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
