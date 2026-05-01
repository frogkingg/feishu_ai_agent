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
import { personalWorkspaceName } from "../utils/personalWorkspace";

const README_LABEL = "README / 项目总览";
const PROJECT_BOARD_LABEL = "Project Board / 进度与待办";
const TIMELINE_LABEL = "Timeline / 里程碑与甘特";
const MEETINGS_LABEL = "Meetings / 会议记录";
const RESOURCES_LABEL = "Docs & Resources / 文档与资料";
const DECISIONS_RISKS_LABEL = "Decisions & Risks / 决策与风险";
const CALENDAR_LABEL = "Calendar / 日程索引";

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

function markdownTable(headers: string[], rows: string[][]): string {
  const escapeCell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)
  ].join("\n");
}

function progressBar(done: number, total: number): string {
  if (total <= 0) {
    return "---------- 0%";
  }

  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * 10);
  return `${"#".repeat(filled)}${"-".repeat(10 - filled)} ${Math.round(ratio * 100)}%`;
}

function statusFromCounts(input: { actions: number; calendars: number; risks: number }): string {
  if (input.risks > 0) {
    return "At risk";
  }

  if (input.actions > 0 || input.calendars > 0) {
    return "In progress";
  }

  return "Watching";
}

function timelineRows(meetings: MeetingRow[], calendars: CalendarDraftRow[]): string[][] {
  const meetingRows = meetings.map((meeting) => [
    "会议",
    meeting.started_at ?? "待补充",
    "已记录",
    formatMeetingReference(meeting, {
      preferredLink: "minutes",
      hideInternalId: true
    })
  ]);
  const calendarRows = calendars.map((calendar) => [
    "后续日程",
    calendar.start_time ?? "待补充",
    calendar.start_time ? "待确认" : "缺少时间",
    `${calendar.title}（来源${sourceMeetingReference(
      new Map(meetings.map((meeting) => [meeting.id, meeting])),
      calendar.meeting_id
    )}）`
  ]);

  return [...meetingRows, ...calendarRows];
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
      label: PROJECT_BOARD_LABEL,
      page_type: "board",
      source_signals: ["actions", "risks"],
      renderMarkdown: (title) => {
        const rows = [
          [
            "P0",
            "确认并推进明确待办",
            statusFromCounts({
              actions: actionIndex.length,
              calendars: calendarIndex.length,
              risks: risks.length
            }),
            progressBar(
              input.actions.filter((action) => action.confirmation_status === "executed").length,
              input.actions.length
            ),
            actionIndex.length > 0 ? actionIndex.slice(0, 3).join("<br>") : "暂无待办"
          ],
          [
            "P1",
            "沉淀会议结论与资料",
            decisions.length > 0 || input.sources.length > 0 ? "In progress" : "Watching",
            progressBar(
              decisions.length + input.sources.length,
              Math.max(1, input.meetings.length + input.sources.length)
            ),
            decisions.length > 0 ? decisions.slice(0, 3).join("<br>") : "暂无决策沉淀"
          ],
          [
            "P2",
            "跟踪风险与后续优化",
            risks.length > 0 ? "At risk" : "Watching",
            progressBar(0, Math.max(1, risks.length)),
            risks.length > 0 ? risks.slice(0, 3).join("<br>") : "暂无风险"
          ]
        ];

        return [
          `# ${title}`,
          "",
          markdownTable(["优先级", "泳道", "状态", "完成度", "当前信号"], rows)
        ].join("\n");
      }
    },
    {
      label: TIMELINE_LABEL,
      page_type: "timeline",
      source_signals: ["always", "calendars"],
      renderMarkdown: (title) =>
        [
          `# ${title}`,
          "",
          markdownTable(
            ["阶段", "时间", "状态", "来源会议"],
            timelineRows(input.meetings, input.calendars)
          )
        ].join("\n")
    },
    {
      label: MEETINGS_LABEL,
      page_type: "meetings",
      source_signals: ["always"],
      renderMarkdown: (title) =>
        [
          `# ${title}`,
          "",
          "## 会议摘要",
          bulletList(meetingSummaries, "暂无会议总结"),
          "",
          "## 转写记录",
          "会议全文不直接塞入模型上下文；这里仅保留转写记录引用。",
          "",
          bulletList(transcriptRefs, "暂无转写记录引用")
        ].join("\n")
    },
    {
      label: RESOURCES_LABEL,
      page_type: "resources",
      source_signals: ["sources"],
      renderMarkdown: (title) =>
        [
          `# ${title}`,
          "",
          "## 关键链接 / 来源",
          bulletList(
            [...meetingRefs, ...input.sources.map((source) => `资料：${source}`)],
            "暂无来源"
          ),
          "",
          "## 资料引用",
          bulletList(input.sources, "暂无关联资料")
        ].join("\n")
    },
    {
      label: DECISIONS_RISKS_LABEL,
      page_type: "decisions",
      source_signals: ["decisions", "risks"],
      renderMarkdown: (title) =>
        [
          `# ${title}`,
          "",
          "## 决策",
          bulletList(decisions, "暂无关键结论与决策"),
          "",
          "## 风险",
          bulletList(risks, "暂无风险、问题与待验证假设")
        ].join("\n")
    },
    {
      label: CALENDAR_LABEL,
      page_type: "calendar",
      source_signals: ["calendars"],
      renderMarkdown: (title) =>
        [`# ${title}`, "", bulletList(calendarIndex, "暂无日程")].join("\n")
    }
  ];

  const pageTitles = [
    numberedTitle(0, README_LABEL),
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
      `项目：${input.name}`,
      "",
      "## 项目简介",
      input.goal,
      "",
      "## 当前状态",
      bulletList(signalSummary, "暂无内容信号"),
      "",
      "## 下一步",
      bulletList(actionIndex.slice(0, 5), "暂无待办"),
      "",
      "## 关键链接 / 来源",
      bulletList([...meetingRefs, ...input.sources.map((source) => `资料：${source}`)], "暂无来源"),
      "",
      "## 仓库式目录",
      bulletList(pageTitles, "暂无结构"),
      "",
      "## 主题关键词",
      bulletList(input.keywords, "暂无关键词"),
      "",
      "## 会议范围",
      bulletList(meetingRefs, "暂无会议")
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
  const workspaceName = personalWorkspaceName();
  const goal = `沉淀 ${input.topicName} 相关会议结论、执行事项、日程和来源资料，形成${workspaceName}可持续更新的项目记录。`;
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
    description: `由 ${input.meetings.length} 场相关会议 dry-run 创建的项目知识库。`,
    owner: input.owner,
    status: "active",
    confidence_origin: input.confidenceOrigin,
    related_keywords: keywords,
    created_from_meetings: input.meetings.map((meeting) => meeting.id),
    pages
  });
}
