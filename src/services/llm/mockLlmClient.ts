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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item)
      )
    : [];
}

function extractCuratorDigest(userPrompt: string): Record<string, unknown> {
  const marker = "digest:";
  const start = userPrompt.lastIndexOf(marker);
  if (start < 0) {
    return {};
  }

  try {
    return asRecord(JSON.parse(userPrompt.slice(start + marker.length).trim()) as unknown);
  } catch {
    return {};
  }
}

function mockKnowledgeBaseDraft(input: GenerateJsonInput): unknown {
  const digest = extractCuratorDigest(input.userPrompt);
  const topic = asRecord(digest.topic);
  const meetings = arrayValue(digest.meetings);
  const actions = arrayValue(digest.actions);
  const calendars = arrayValue(digest.calendars);
  const topicName = stringValue(topic.name, "Mock 主题知识库");
  const goal = stringValue(topic.goal, "沉淀相关会议结论、行动项、日程与来源资料。");
  const meetingRows = meetings
    .map((meeting) => {
      const title = stringValue(meeting.title, "未命名会议");
      const summary = stringValue(meeting.summary, "暂无摘要");
      const source = stringValue(meeting.minutes_reference, title);
      return `| ${title} | ${summary} | ${source} |`;
    })
    .join("\n");
  const actionLines = actions.map((action) => `- ${stringValue(action.title, "待办草案")}`);
  const calendarLines = calendars.map((calendar) => `- ${stringValue(calendar.title, "日程草案")}`);
  const archiveLines = meetings.map((meeting) => {
    const title = stringValue(meeting.title, "未命名会议");
    const minutes = stringValue(meeting.minutes_reference, title);
    const transcript = stringValue(meeting.transcript_reference, "暂无转写引用");
    return `- ${title}：${minutes}；${transcript}`;
  });
  const pages = [
    {
      title: "00 README / Dashboard",
      page_type: "home",
      source_signals: ["always"],
      markdown: [
        "# 00 README / Dashboard",
        "",
        "## Dashboard / Overview",
        goal,
        "",
        "## 策展判断",
        "Mock LLM 根据 digest 生成多页面草案；正式环境由真实 LLM 按 Skill 自适应策展。",
        "",
        "## 会议范围",
        "| 会议 | 摘要 | 来源 |",
        "| --- | --- | --- |",
        meetingRows || "| 暂无会议 | 暂无摘要 | 暂无来源 |"
      ].join("\n")
    },
    {
      title: "01 Core Content / 主题模块",
      page_type: "index",
      source_signals: ["always"],
      markdown: [
        "# 01 Core Content / 主题模块",
        "",
        "## 当前最佳版本",
        "围绕读者任务整理摘要、行动和日程；不在正文放完整转写。",
        "",
        "## 行动与日程",
        [...actionLines, ...calendarLines].join("\n") || "- 暂无待确认行动或日程"
      ].join("\n")
    },
    {
      title: "02 Merged FAQ / 问题合并",
      page_type: "analysis",
      source_signals: ["always"],
      markdown: [
        "# 02 Merged FAQ / 问题合并",
        "",
        "| Question | Current Answer | Sources |",
        "| --- | --- | --- |",
        "| 如何阅读这个知识库？ | 先看 Dashboard，再进入主题页；需要证据时查看 Archive。 | Archive |"
      ].join("\n")
    },
    {
      title: "03 Archive / 来源追溯",
      page_type: "sources",
      source_signals: ["always", "sources"],
      markdown: [
        "# 03 Archive / 来源追溯",
        "",
        "## 来源索引",
        archiveLines.join("\n") || "- 暂无来源"
      ].join("\n")
    }
  ];

  if (actions.length > 0) {
    pages.push({
      title: "04 Project Board / 行动与风险",
      page_type: "board",
      source_signals: ["actions"],
      markdown: ["# 04 Project Board / 行动与风险", "", actionLines.join("\n")].join("\n")
    });
  }

  if (calendars.length > 0) {
    pages.push({
      title: "05 Calendar / 日程索引",
      page_type: "calendar",
      source_signals: ["calendars"],
      markdown: ["# 05 Calendar / 日程索引", "", calendarLines.join("\n")].join("\n")
    });
  }

  return {
    kb_id: "mock_kb",
    name: topicName,
    goal,
    description: "Mock LLM 生成的知识库草案。",
    owner: typeof topic.owner === "string" ? topic.owner : null,
    status: "active",
    confidence_origin: typeof topic.confidence_origin === "number" ? topic.confidence_origin : 0.7,
    related_keywords: Array.isArray(topic.keywords) ? topic.keywords : [],
    created_from_meetings: meetings.map((meeting, index) =>
      stringValue(meeting.source_ref, `M${index + 1}`)
    ),
    pages
  };
}

export class MockLlmClient implements LlmClient {
  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    if (input.schemaName === "KnowledgeBaseDraft") {
      return mockKnowledgeBaseDraft(input) as T;
    }

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
