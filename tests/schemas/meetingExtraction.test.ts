import { MeetingExtractionResultSchema } from "../../src/schemas";

describe("MeetingExtractionResultSchema", () => {
  it("accepts a structured extraction result", () => {
    const parsed = MeetingExtractionResultSchema.parse({
      meeting_summary: "本次会议确认先调研无人机操作流程和试飞权限。",
      key_decisions: [
        {
          decision: "先调研流程，不急着做技术方案。",
          evidence: "先把流程摸清楚，不急着做技术方案。"
        }
      ],
      action_items: [
        {
          title: "整理现有操作流程",
          description: null,
          owner: "张三",
          collaborators: [],
          due_date: "2026-05-01",
          priority: "P1",
          evidence: "张三整理现有操作流程，周五前给大家看。",
          confidence: 0.88,
          suggested_reason: "明确点名张三负责。",
          missing_fields: []
        }
      ],
      calendar_drafts: [
        {
          title: "无人机操作员访谈",
          start_time: null,
          end_time: null,
          duration_minutes: null,
          participants: ["张三", "李四"],
          agenda: null,
          location: null,
          evidence: "下周二上午再约操作员访谈。",
          confidence: 0.78,
          missing_fields: ["start_time"]
        }
      ],
      topic_keywords: ["无人机", "操作流程", "试飞权限"],
      risks: [
        {
          risk: "试飞权限未确认。",
          evidence: "试飞权限还没确认。"
        }
      ],
      source_mentions: [
        {
          type: "doc",
          name_or_keyword: "无人机安全规范",
          reason: "会议提到需要参考该规范"
        }
      ],
      confidence: 0.83
    });

    expect(parsed.action_items).toHaveLength(1);
  });
});
