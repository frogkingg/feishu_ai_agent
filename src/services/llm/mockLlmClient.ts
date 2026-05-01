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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
    : [];
}

function extractPromptObject(userPrompt: string, marker: string): Record<string, unknown> {
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

function extractCuratorDigest(userPrompt: string): Record<string, unknown> {
  return extractPromptObject(userPrompt, "digest:");
}

function sharedValues(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((item) => rightSet.has(item)))];
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
  const actionLines = actions.map((action) => {
    const owner = stringValue(action.owner, "待确认");
    const due = stringValue(action.due_date, "待确认");
    const source = stringValue(action.source, "来源待确认");
    return `- ${stringValue(action.title, "待办草案")}；负责人：${owner}；截止：${due}；来源：${source}`;
  });
  const calendarLines = calendars.map((calendar) => {
    const time = stringValue(calendar.start_time, "时间待确认");
    const source = stringValue(calendar.source, "来源待确认");
    return `- ${stringValue(calendar.title, "日程草案")}；时间：${time}；来源：${source}`;
  });
  const archiveLines = meetings.map((meeting) => {
    const title = stringValue(meeting.title, "未命名会议");
    const minutes = stringValue(meeting.minutes_reference, title);
    const transcript = stringValue(meeting.transcript_reference, "暂无转写引用");
    return `- ${title}：${minutes}；${transcript}`;
  });
  const meetingSummaryPages = meetings.map((meeting, index) => {
    const title = stringValue(meeting.title, `会议 ${index + 1}`);
    const summary = stringValue(meeting.summary, "暂无摘要");
    const excerpt = stringValue(meeting.transcript_excerpt, "暂无转写摘录");
    const minutes = stringValue(meeting.minutes_reference, title);
    const transcript = stringValue(meeting.transcript_reference, "暂无转写引用");
    return {
      title: `${String(7 + index).padStart(2, "0")} 会议总结 / M${index + 1} ${title}`,
      page_type: "meeting_summary",
      source_signals: ["always", "sources"],
      markdown: [
        `# ${String(7 + index).padStart(2, "0")} 会议总结 / M${index + 1} ${title}`,
        "",
        "## 会议摘要",
        summary,
        "",
        "## 必要摘录",
        excerpt,
        "",
        "## 来源",
        `- 纪要：${minutes}`,
        `- 转写：${transcript}`
      ].join("\n")
    };
  });
  const afterMeetingIndex = 7 + meetingSummaryPages.length;
  const pages = [
    {
      title: "00 首页 / 总览",
      page_type: "home",
      source_signals: ["always"],
      markdown: [
        "# 00 首页 / 总览",
        "",
        "## 当前状态",
        `Mock LLM 已根据 ${meetings.length} 场会议生成主题知识库草案。`,
        "",
        "## 下一步",
        [...actionLines.slice(0, 4), ...calendarLines.slice(0, 2)].join("\n") ||
          "- 等待用户确认下一步行动和日程",
        "",
        "## 关键结论",
        meetings
          .map(
            (meeting) =>
              `- ${stringValue(meeting.title, "未命名会议")}：${stringValue(meeting.summary, "暂无摘要")}`
          )
          .join("\n") || "- 暂无关键结论",
        "",
        "## 未解决问题",
        "- 哪些待办和日程会被用户确认执行？",
        "- 会议中的风险、假设和外部资料仍需持续补充。"
      ].join("\n")
    },
    {
      title: "01 整体目标",
      page_type: "goal",
      source_signals: ["always"],
      markdown: [
        "# 01 整体目标",
        "",
        "## 目标",
        goal,
        "",
        "## 成功口径",
        "读者能快速理解主题背景、当前状态、关键决策、待办日程和来源。"
      ].join("\n")
    },
    {
      title: "02 整体分析",
      page_type: "analysis",
      source_signals: ["always"],
      markdown: [
        "# 02 整体分析",
        "",
        "## 跨会议分析",
        "Mock LLM 根据 digest 汇总会议摘要、行动证据、日程证据和来源引用；真实 LLM 会进一步判断主题结构。",
        "",
        "| 会议 | 摘要 | 来源 |",
        "| --- | --- | --- |",
        meetingRows || "| 暂无会议 | 暂无摘要 | 暂无来源 |"
      ].join("\n")
    },
    {
      title: "03 当前进度",
      page_type: "progress",
      source_signals: ["always", "actions", "calendars"],
      markdown: [
        "# 03 当前进度",
        "",
        "## 已沉淀",
        meetings.map((meeting) => `- ${stringValue(meeting.title, "未命名会议")}`).join("\n") ||
          "- 暂无会议",
        "",
        "## 下一步",
        [...actionLines, ...calendarLines].join("\n") || "- 暂无待确认行动或日程"
      ].join("\n")
    },
    {
      title: "04 关键结论与决策",
      page_type: "decisions",
      source_signals: ["decisions", "sources"],
      markdown: [
        "# 04 关键结论与决策",
        "",
        meetings
          .map(
            (meeting) =>
              `- ${stringValue(meeting.title, "未命名会议")}：${stringValue(meeting.summary, "暂无摘要")}`
          )
          .join("\n") || "- 暂无可确认结论"
      ].join("\n")
    },
    {
      title: "05 待办与日程索引",
      page_type: "board",
      source_signals: ["actions", "calendars"],
      markdown: [
        "# 05 待办与日程索引",
        "",
        "## 待办索引",
        actionLines.join("\n") || "- 暂无待办",
        "",
        "## 日程索引",
        calendarLines.join("\n") || "- 暂无日程"
      ].join("\n")
    },
    {
      title: "06 会议索引",
      page_type: "meetings",
      source_signals: ["always", "sources"],
      markdown: [
        "# 06 会议索引",
        "",
        "| 会议 | 摘要 | 来源 |",
        "| --- | --- | --- |",
        meetingRows || "| 暂无会议 | 暂无摘要 | 暂无来源 |"
      ].join("\n")
    },
    ...meetingSummaryPages,
    {
      title: `${String(afterMeetingIndex).padStart(2, "0")} 转写引用`,
      page_type: "transcript",
      source_signals: ["sources"],
      markdown: [
        `# ${String(afterMeetingIndex).padStart(2, "0")} 转写引用`,
        "",
        "## 转写与纪要入口",
        archiveLines.join("\n") || "- 暂无来源",
        "",
        "## 写入边界",
        "不写入完整转写，只保留必要摘录和引用。"
      ].join("\n")
    },
    {
      title: `${String(afterMeetingIndex + 1).padStart(2, "0")} 关联资料`,
      page_type: "resources",
      source_signals: ["sources"],
      markdown: [
        `# ${String(afterMeetingIndex + 1).padStart(2, "0")} 关联资料`,
        "",
        archiveLines.join("\n") || "- 暂无关联资料"
      ].join("\n")
    },
    {
      title: `${String(afterMeetingIndex + 2).padStart(2, "0")} 风险与假设`,
      page_type: "risks",
      source_signals: ["risks", "sources"],
      markdown: [
        `# ${String(afterMeetingIndex + 2).padStart(2, "0")} 风险与假设`,
        "",
        "- 风险和假设应由真实 LLM 根据摘要、证据和转写摘录继续细化。",
        "- 不确定结论保持待确认，并指向来源。"
      ].join("\n")
    },
    {
      title: `${String(afterMeetingIndex + 3).padStart(2, "0")} 变更记录`,
      page_type: "changelog",
      source_signals: ["always"],
      markdown: [
        `# ${String(afterMeetingIndex + 3).padStart(2, "0")} 变更记录`,
        "",
        `- 创建知识库草案：${meetings.length} 场会议进入初始范围。`
      ].join("\n")
    }
  ];

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

function hasAnyTopicEvidence(context: Record<string, unknown>): boolean {
  const extraction = asRecord(context.extraction);
  return (
    stringArray(extraction.topic_keywords).length > 0 ||
    arrayValue(extraction.key_decisions).length > 0 ||
    arrayValue(extraction.risks).length > 0 ||
    arrayValue(extraction.action_items).length > 0 ||
    arrayValue(extraction.calendar_drafts).length > 0 ||
    arrayValue(extraction.source_mentions).length > 0
  );
}

function hasExplicitKnowledgeCreateIntent(context: Record<string, unknown>): boolean {
  const currentMeeting = asRecord(context.current_meeting);
  const extraction = asRecord(context.extraction);
  const actionText = arrayValue(extraction.action_items)
    .map((item) =>
      [
        item.title,
        item.description,
        item.evidence,
        item.suggested_reason
      ]
        .map((value) => stringValue(value, ""))
        .join(" ")
    )
    .join(" ");
  const text = [
    currentMeeting.title,
    currentMeeting.summary,
    currentMeeting.transcript_excerpt,
    extraction.meeting_summary,
    actionText
  ].join(" ");

  return (
    /(?:整理|创建|新建|建立|搭建|沉淀|归档|做成|生成).{0,30}(?:知识库|调研档案|项目资料|onboarding\s*包|新人上手包|上手包)/i.test(
      text
    ) ||
    /(?:知识库|调研档案|项目资料|onboarding\s*包|新人上手包|上手包).{0,30}(?:整理|创建|新建|建立|搭建|沉淀|归档|生成)/i.test(
      text
    )
  );
}

function mockTopicMatch(input: GenerateJsonInput): unknown {
  const context = extractPromptObject(input.userPrompt, "topic_clustering_context:");
  const currentMeeting = asRecord(context.current_meeting);
  const extraction = asRecord(context.extraction);
  const currentMeetingId = stringValue(currentMeeting.id, "mtg_current");
  const currentKeywords = [
    ...stringArray(currentMeeting.keywords),
    ...stringArray(extraction.topic_keywords)
  ];
  const currentText = [
    currentMeeting.title,
    currentMeeting.summary,
    currentMeeting.transcript_excerpt,
    extraction.meeting_summary
  ].join(" ");
  const candidateMeetings = arrayValue(context.candidate_meetings);
  const existingKnowledgeBases = arrayValue(context.existing_knowledge_bases);

  const matchedKnowledgeBase = existingKnowledgeBases.find((knowledgeBase) => {
    const relatedKeywords = stringArray(knowledgeBase.related_keywords);
    return sharedValues(currentKeywords, relatedKeywords).length > 0;
  });

  if (matchedKnowledgeBase) {
    const matchedKbId = stringValue(matchedKnowledgeBase.id, "kb_mock");
    return {
      current_meeting_id: currentMeetingId,
      matched_kb_id: matchedKbId,
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

  const relatedCandidates = candidateMeetings.filter((meeting) => {
    const candidateKeywords = stringArray(meeting.keywords);
    const candidateText = [meeting.title, meeting.summary, meeting.transcript_excerpt].join(" ");
    return (
      sharedValues(currentKeywords, candidateKeywords).length > 0 ||
      candidateKeywords.some((keyword) => currentText.includes(keyword)) ||
      currentKeywords.some((keyword) => candidateText.includes(keyword))
    );
  });

  if (hasExplicitKnowledgeCreateIntent(context)) {
    return {
      current_meeting_id: currentMeetingId,
      matched_kb_id: null,
      matched_kb_name: null,
      score: 0.9,
      match_reasons: ["Mock LLM 判断当前会议显式要求创建或沉淀知识库"],
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
      score: 0.9,
      match_reasons: ["Mock LLM 判断当前会议和历史会议形成同一主题"],
      suggested_action: "ask_create",
      candidate_meeting_ids: [
        ...relatedCandidates.map((meeting) => stringValue(meeting.id, "")).filter(Boolean),
        currentMeetingId
      ]
    };
  }

  if (hasAnyTopicEvidence(context)) {
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

export class MockLlmClient implements LlmClient {
  async generateJson<T>(input: GenerateJsonInput): Promise<T> {
    if (input.schemaName === "KnowledgeBaseDraft") {
      return mockKnowledgeBaseDraft(input) as T;
    }

    if (input.schemaName === "TopicMatchResult") {
      return mockTopicMatch(input) as T;
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
