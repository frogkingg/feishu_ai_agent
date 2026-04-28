import { KnowledgeBaseDraft, KnowledgeBaseDraftSchema, KnowledgeBasePage } from "../schemas";
import { ActionItemRow, CalendarDraftRow, MeetingRow } from "../services/store/repositories";
import { stableDemoId } from "../utils/id";

const DEFAULT_PAGE_TITLES = [
  "00 首页 / 总览",
  "01 整体目标",
  "02 整体分析",
  "03 当前进度",
  "04 关键结论与决策",
  "05 待办与日程索引",
  "06 单个会议总结",
  "07 会议转写记录",
  "08 关联资料",
  "09 风险、问题与待验证假设",
  "10 变更记录"
] as const;

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function bulletList(values: string[], fallback: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function meetingLabel(meeting: MeetingRow): string {
  return `${meeting.title}${meeting.started_at ? `（${meeting.started_at}）` : ""}`;
}

function extractSourceReferences(meetings: MeetingRow[]): string[] {
  const fromQuotedText = meetings.flatMap((meeting) => {
    const matches = [...meeting.transcript_text.matchAll(/[“"]([^”"]+)[”"]/g)];
    return matches.map((match) => match[1]);
  });
  const knownReferences = meetings.some((meeting) => meeting.transcript_text.includes("无人机安全规范"))
    ? ["无人机安全规范"]
    : [];

  return unique([...knownReferences, ...fromQuotedText]);
}

function extractDecisions(meetings: MeetingRow[]): string[] {
  return unique(
    meetings.flatMap((meeting) => {
      const decisions: string[] = [];
      if (meeting.transcript_text.includes("先调研流程，不急着做技术方案")) {
        decisions.push("先调研流程，不急着做技术方案。");
      }
      if (meeting.transcript_text.includes("统一操作 SOP")) {
        decisions.push("需要建立统一操作 SOP。");
      }
      return decisions;
    })
  );
}

function extractRisks(meetings: MeetingRow[]): string[] {
  return unique(
    meetings.flatMap((meeting) => {
      const risks: string[] = [];
      if (meeting.transcript_text.includes("试飞权限")) {
        risks.push("试飞权限仍需确认并纳入风险控制。");
      }
      if (meeting.transcript_text.includes("天气") || meeting.transcript_text.includes("电池状态")) {
        risks.push("天气、电池状态和现场安全员需要进入统一风险清单。");
      }
      return risks;
    })
  );
}

function renderActionIndex(actions: ActionItemRow[]): string[] {
  return actions.map((action) => {
    const due = action.due_date ? `，截止 ${action.due_date}` : "";
    const owner = action.owner ? `，负责人 ${action.owner}` : "";
    return `${action.title}${owner}${due}（来源会议 ${action.meeting_id}）`;
  });
}

function renderCalendarIndex(calendars: CalendarDraftRow[]): string[] {
  return calendars.map((calendar) => {
    const time = calendar.start_time ? `，时间 ${calendar.start_time}` : "";
    return `${calendar.title}${time}（来源会议 ${calendar.meeting_id}）`;
  });
}

function buildPages(input: {
  name: string;
  goal: string;
  meetings: MeetingRow[];
  actions: ActionItemRow[];
  calendars: CalendarDraftRow[];
  keywords: string[];
  sources: string[];
}): KnowledgeBasePage[] {
  const meetingSummaries = input.meetings.map(
    (meeting) => `${meetingLabel(meeting)}：${meeting.summary ?? "暂无摘要"}`
  );
  const decisions = extractDecisions(input.meetings);
  const risks = extractRisks(input.meetings);
  const actionIndex = renderActionIndex(input.actions);
  const calendarIndex = renderCalendarIndex(input.calendars);
  const meetingRefs = input.meetings.map((meeting) => `会议 ${meeting.id}：${meetingLabel(meeting)}`);

  return [
    {
      title: DEFAULT_PAGE_TITLES[0],
      page_type: "home",
      markdown: [
        `# ${DEFAULT_PAGE_TITLES[0]}`,
        "",
        `主题知识库：${input.name}`,
        "",
        "## 默认结构",
        bulletList([...DEFAULT_PAGE_TITLES], "暂无结构"),
        "",
        "## 会议范围",
        bulletList(meetingRefs, "暂无会议"),
        "",
        "## 来源引用",
        bulletList([...meetingRefs, ...input.sources.map((source) => `资料：${source}`)], "暂无来源")
      ].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[1],
      page_type: "goal",
      markdown: [`# ${DEFAULT_PAGE_TITLES[1]}`, "", input.goal].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[2],
      page_type: "analysis",
      markdown: [
        `# ${DEFAULT_PAGE_TITLES[2]}`,
        "",
        "## 主题关键词",
        bulletList(input.keywords, "暂无关键词"),
        "",
        "## 会议摘要",
        bulletList(meetingSummaries, "暂无会议摘要")
      ].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[3],
      page_type: "progress",
      markdown: [
        `# ${DEFAULT_PAGE_TITLES[3]}`,
        "",
        "当前进度来自已确认或待确认的任务与日程草案。",
        "",
        "## 待办",
        bulletList(actionIndex, "暂无待办"),
        "",
        "## 日程",
        bulletList(calendarIndex, "暂无日程")
      ].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[4],
      page_type: "decisions",
      markdown: [`# ${DEFAULT_PAGE_TITLES[4]}`, "", bulletList(decisions, "暂无关键结论与决策")].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[5],
      page_type: "index",
      markdown: [
        `# ${DEFAULT_PAGE_TITLES[5]}`,
        "",
        "## 待办索引",
        bulletList(actionIndex, "暂无待办"),
        "",
        "## 日程索引",
        bulletList(calendarIndex, "暂无日程")
      ].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[6],
      page_type: "meeting_summary",
      markdown: [`# ${DEFAULT_PAGE_TITLES[6]}`, "", bulletList(meetingSummaries, "暂无会议总结")].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[7],
      page_type: "transcript",
      markdown: [
        `# ${DEFAULT_PAGE_TITLES[7]}`,
        "",
        "会议全文不直接塞入模型上下文；这里仅保留转写记录引用。",
        "",
        bulletList(
          input.meetings.map((meeting) => `会议 ${meeting.id}：${meeting.title}，transcript_text 已存入本地 meetings 表`),
          "暂无转写记录引用"
        )
      ].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[8],
      page_type: "sources",
      markdown: [`# ${DEFAULT_PAGE_TITLES[8]}`, "", bulletList(input.sources, "暂无关联资料")].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[9],
      page_type: "risks",
      markdown: [`# ${DEFAULT_PAGE_TITLES[9]}`, "", bulletList(risks, "暂无风险、问题与待验证假设")].join("\n")
    },
    {
      title: DEFAULT_PAGE_TITLES[10],
      page_type: "changelog",
      markdown: [
        `# ${DEFAULT_PAGE_TITLES[10]}`,
        "",
        `- dry-run 创建主题知识库，纳入 ${input.meetings.length} 场会议。`
      ].join("\n")
    }
  ];
}

export function renderKnowledgeBaseMarkdown(draft: KnowledgeBaseDraft): string {
  return draft.pages.map((page) => page.markdown).join("\n\n---\n\n");
}

export function runKnowledgeCuratorAgent(input: {
  topicName: string;
  owner: string | null;
  meetings: MeetingRow[];
  actions: ActionItemRow[];
  calendars: CalendarDraftRow[];
  confidenceOrigin: number;
}): KnowledgeBaseDraft {
  const keywords = unique(input.meetings.flatMap((meeting) => parseStringArray(meeting.keywords_json)));
  const sources = extractSourceReferences(input.meetings);
  const goal = input.topicName.includes("无人机")
    ? "沉淀无人机当前操作流程、试飞权限、风险控制和统一操作 SOP 的会议结论与执行闭环。"
    : `沉淀 ${input.topicName} 相关会议结论、执行事项和来源资料。`;
  const pages = buildPages({
    name: input.topicName,
    goal,
    meetings: input.meetings,
    actions: input.actions,
    calendars: input.calendars,
    keywords,
    sources
  });

  return KnowledgeBaseDraftSchema.parse({
    kb_id: stableDemoId("kb", input.topicName),
    name: input.topicName,
    goal,
    description: `由 ${input.meetings.length} 场相关会议 dry-run 创建的主题知识库。`,
    owner: input.owner,
    status: "active",
    confidence_origin: input.confidenceOrigin,
    related_keywords: keywords,
    created_from_meetings: input.meetings.map((meeting) => meeting.id),
    pages
  });
}
