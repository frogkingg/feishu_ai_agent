import {
  KnowledgeBaseDraft,
  KnowledgeBaseDraftSchema,
  KnowledgeBasePage,
  KnowledgeBasePageSignal
} from "../schemas";
import { ActionItemRow, CalendarDraftRow, MeetingRow } from "../services/store/repositories";
import {
  formatMeetingReference,
  formatOpenIdsInText,
  formatUserForDisplay,
  formatUserListForDisplay
} from "../utils/display";
import { stableDemoId } from "../utils/id";

const HOME_PAGE_LABEL = "Henry 个人工作台 / 总览";
const MEETING_SUMMARY_LABEL = "会议总结";
const TRANSCRIPT_LABEL = "会议转写记录";
const DECISIONS_LABEL = "关键结论与决策";
const ACTION_CALENDAR_INDEX_LABEL = "待办与日程索引";
const ACTION_INDEX_LABEL = "待办索引";
const CALENDAR_INDEX_LABEL = "日程索引";
const SOURCES_LABEL = "关联资料";
const RISKS_LABEL = "风险、问题与待验证假设";

const DecisionPatterns = [
  /结论/,
  /决定/,
  /明确/,
  /确定/,
  /同意/,
  /必须/,
  /需要建立/,
  /形成.{0,12}结论/
];
const RiskPatterns = [
  /风险/,
  /阻塞/,
  /不确定/,
  /待验证/,
  /尚未/,
  /未确认/,
  /担心/,
  /缺少/,
  /权限.{0,8}确认/,
  /审批.{0,8}材料/,
  /影响.{0,8}排期/
];

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
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

function numberedTitle(index: number, label: string): string {
  return `${index.toString().padStart(2, "0")} ${label}`;
}

function meetingLabel(meeting: MeetingRow): string {
  return `${meeting.title}${meeting.started_at ? `（${meeting.started_at}）` : ""}`;
}

function evidenceFragments(text: string): string[] {
  return text
    .split(/[\n。；;!?！？]/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
}

function extractMarkedFragments(meetings: MeetingRow[], patterns: RegExp[]): string[] {
  return unique(
    meetings.flatMap((meeting) => {
      const text = [meeting.summary ?? "", meeting.transcript_text].join("\n");
      return evidenceFragments(text)
        .filter((fragment) => patterns.some((pattern) => pattern.test(fragment)))
        .map((fragment) => `${meetingLabel(meeting)}：${fragment}`);
    })
  );
}

function sourceReferenceMatches(text: string): string[] {
  const matches = [
    ...text.matchAll(/[“"]([^”"]+)[”"]/g),
    ...text.matchAll(/《([^》]+)》/g),
    ...text.matchAll(/资料(?:上|里)?.{0,8}参考[“"《]?([^”"》。，；;\n]+)[”"》]?/g),
    ...text.matchAll(/(?:参考|参照)[“"《]?([^”"》。，；;\n]+)[”"》]?/g),
    ...text.matchAll(/上次提到的([^，。；;\n]+?)(?:也要|仍要|继续)?参考/g)
  ];

  return matches.map((match) => formatOpenIdsInText(match[1]));
}

function normalizeSourceReference(value: string): string {
  return value
    .replace(/^的/, "")
    .replace(/^(这份|这个|该|上次提到的)/, "")
    .replace(/也要继续$/, "")
    .trim();
}

function isUsefulSourceReference(value: string): boolean {
  return value.length >= 2 && !["资料", "文档", "材料", "规范"].includes(value);
}

function extractSourceReferences(meetings: MeetingRow[]): string[] {
  return unique(
    meetings.flatMap((meeting) =>
      sourceReferenceMatches(meeting.transcript_text)
        .map(normalizeSourceReference)
        .filter(isUsefulSourceReference)
    )
  );
}

function extractDecisions(meetings: MeetingRow[]): string[] {
  return extractMarkedFragments(meetings, DecisionPatterns);
}

function extractRisks(meetings: MeetingRow[]): string[] {
  return extractMarkedFragments(meetings, RiskPatterns);
}

function parseParticipantsForDisplay(value: string): string[] {
  return formatUserListForDisplay(parseStringArray(value));
}

function sourceMeetingReference(meetingsById: Map<string, MeetingRow>, meetingId: string): string {
  const meeting = meetingsById.get(meetingId);
  return meeting
    ? formatMeetingReference(meeting, {
        preferredLink: "minutes",
        hideInternalId: true
      })
    : "来源会议";
}

function renderActionIndex(
  actions: ActionItemRow[],
  meetingsById: Map<string, MeetingRow>
): string[] {
  return actions.map((action) => {
    const due = action.due_date ? `，截止 ${action.due_date}` : "";
    const owner = action.owner ? `，负责人 ${formatUserForDisplay(action.owner)}` : "";
    return `${action.title}${owner}${due}（来源${sourceMeetingReference(
      meetingsById,
      action.meeting_id
    )}）`;
  });
}

function renderCalendarIndex(
  calendars: CalendarDraftRow[],
  meetingsById: Map<string, MeetingRow>
): string[] {
  return calendars.map((calendar) => {
    const time = calendar.start_time ? `，时间 ${calendar.start_time}` : "";
    const participants = parseParticipantsForDisplay(calendar.participants_json);
    const participantText = participants.length > 0 ? `，参与人 ${participants.join("、")}` : "";
    return `${calendar.title}${time}${participantText}（来源${sourceMeetingReference(
      meetingsById,
      calendar.meeting_id
    )}）`;
  });
}

function transcriptReference(meeting: MeetingRow): string {
  const reference = formatMeetingReference(meeting, {
    preferredLink: "transcript",
    hideInternalId: true
  });
  if (
    meeting.transcript_url ||
    meeting.minutes_url ||
    /^https?:\/\//i.test(meeting.external_meeting_id ?? "")
  ) {
    return reference;
  }

  return `${reference}，transcript_text 已存入本地 meetings 表`;
}

type PageDraft = {
  label: string;
  page_type: KnowledgeBasePage["page_type"];
  source_signals: KnowledgeBasePageSignal[];
  renderMarkdown: (title: string) => string;
};

function buildPages(input: {
  name: string;
  goal: string;
  meetings: MeetingRow[];
  actions: ActionItemRow[];
  calendars: CalendarDraftRow[];
  keywords: string[];
  sources: string[];
}): KnowledgeBasePage[] {
  const meetingsById = new Map(input.meetings.map((meeting) => [meeting.id, meeting]));
  const meetingSummaries = input.meetings.map(
    (meeting) =>
      `${formatMeetingReference(meeting, {
        preferredLink: "minutes",
        hideInternalId: true
      })}：${meeting.summary ?? "暂无摘要"}`
  );
  const transcriptRefs = input.meetings.map(transcriptReference);
  const decisions = extractDecisions(input.meetings);
  const risks = extractRisks(input.meetings);
  const actionIndex = renderActionIndex(input.actions, meetingsById);
  const calendarIndex = renderCalendarIndex(input.calendars, meetingsById);
  const meetingRefs = input.meetings.map((meeting) =>
    formatMeetingReference(meeting, {
      preferredLink: "minutes",
      hideInternalId: true
    })
  );
  const pageDrafts: PageDraft[] = [
    {
      label: MEETING_SUMMARY_LABEL,
      page_type: "meeting_summary",
      source_signals: ["always"],
      renderMarkdown: (title) =>
        [`# ${title}`, "", bulletList(meetingSummaries, "暂无会议总结")].join("\n")
    },
    {
      label: TRANSCRIPT_LABEL,
      page_type: "transcript",
      source_signals: ["always"],
      renderMarkdown: (title) =>
        [
          `# ${title}`,
          "",
          "会议全文不直接塞入模型上下文；这里仅保留转写记录引用。",
          "",
          bulletList(transcriptRefs, "暂无转写记录引用")
        ].join("\n")
    }
  ];

  if (decisions.length > 0) {
    pageDrafts.push({
      label: DECISIONS_LABEL,
      page_type: "decisions",
      source_signals: ["decisions"],
      renderMarkdown: (title) =>
        [`# ${title}`, "", bulletList(decisions, "暂无关键结论与决策")].join("\n")
    });
  }

  if (actionIndex.length > 0 || calendarIndex.length > 0) {
    const label =
      actionIndex.length > 0 && calendarIndex.length > 0
        ? ACTION_CALENDAR_INDEX_LABEL
        : actionIndex.length > 0
          ? ACTION_INDEX_LABEL
          : CALENDAR_INDEX_LABEL;
    const sourceSignals: KnowledgeBasePageSignal[] = [
      ...(actionIndex.length > 0 ? (["actions"] as const) : []),
      ...(calendarIndex.length > 0 ? (["calendars"] as const) : [])
    ];

    pageDrafts.push({
      label,
      page_type: "index",
      source_signals: sourceSignals,
      renderMarkdown: (title) => {
        const sections = [`# ${title}`, ""];
        if (actionIndex.length > 0) {
          sections.push("## 待办索引", bulletList(actionIndex, "暂无待办"), "");
        }
        if (calendarIndex.length > 0) {
          sections.push("## 日程索引", bulletList(calendarIndex, "暂无日程"));
        }
        return sections.join("\n").trimEnd();
      }
    });
  }

  if (risks.length > 0) {
    pageDrafts.push({
      label: RISKS_LABEL,
      page_type: "risks",
      source_signals: ["risks"],
      renderMarkdown: (title) =>
        [`# ${title}`, "", bulletList(risks, "暂无风险、问题与待验证假设")].join("\n")
    });
  }

  if (input.sources.length > 0) {
    pageDrafts.push({
      label: SOURCES_LABEL,
      page_type: "sources",
      source_signals: ["sources"],
      renderMarkdown: (title) =>
        [`# ${title}`, "", bulletList(input.sources, "暂无关联资料")].join("\n")
    });
  }

  const pageTitles = [
    numberedTitle(0, HOME_PAGE_LABEL),
    ...pageDrafts.map((page, index) => numberedTitle(index + 1, page.label))
  ];
  const homeTitle = pageTitles[0];
  const signalSummary = [
    `待办：${actionIndex.length} 项`,
    `日程：${calendarIndex.length} 项`,
    `关键结论：${decisions.length} 条`,
    `风险/待验证：${risks.length} 条`,
    `关联资料：${input.sources.length} 条`
  ];
  const homePage: KnowledgeBasePage = {
    title: homeTitle,
    page_type: "home",
    source_signals: ["always"],
    markdown: [
      `# ${homeTitle}`,
      "",
      `个人知识库：${input.name}`,
      "",
      "## 个人工作台目标",
      input.goal,
      "",
      "## 自适应结构",
      bulletList(pageTitles, "暂无结构"),
      "",
      "## 内容信号",
      bulletList(signalSummary, "暂无内容信号"),
      "",
      "## 主题关键词",
      bulletList(input.keywords, "暂无关键词"),
      "",
      "## 会议范围",
      bulletList(meetingRefs, "暂无会议"),
      "",
      "## 来源引用",
      bulletList([...meetingRefs, ...input.sources.map((source) => `资料：${source}`)], "暂无来源")
    ].join("\n")
  };

  return [
    homePage,
    ...pageDrafts.map((page, index) => {
      const title = numberedTitle(index + 1, page.label);
      return {
        title,
        page_type: page.page_type,
        source_signals: page.source_signals,
        markdown: page.renderMarkdown(title)
      };
    })
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
  const keywords = unique(
    input.meetings.flatMap((meeting) => parseStringArray(meeting.keywords_json))
  );
  const sources = extractSourceReferences(input.meetings);
  const goal = `沉淀 ${input.topicName} 相关会议结论、执行事项和来源资料，形成 Henry 个人工作台的可持续更新记录。`;
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
    description: `由 ${input.meetings.length} 场相关会议 dry-run 创建的 Henry 个人知识库。`,
    owner: input.owner,
    status: "active",
    confidence_origin: input.confidenceOrigin,
    related_keywords: keywords,
    created_from_meetings: input.meetings.map((meeting) => meeting.id),
    pages
  });
}
