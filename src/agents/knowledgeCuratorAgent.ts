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

const README_LABEL = "README / Dashboard";
const CORE_CONTENT_LABEL = "Core Content / 主题模块";
const MERGED_FAQ_LABEL = "Merged FAQ / 问题合并";
const ARCHIVE_LABEL = "Archive / 来源追溯";
const PROJECT_BOARD_LABEL = "Project Board / 行动与风险";
const TIMELINE_LABEL = "Timeline / 时间轴与日程";
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
const RecurringMeetingPatterns = [/例会/, /周会/, /双周会/, /月会/, /日报/, /周报/, /站会/, /复盘/];
const ProjectMeetingPatterns = [
  /交付/,
  /负责人/,
  /排期/,
  /里程碑/,
  /截止/,
  /待办/,
  /风险/,
  /阻塞/,
  /上线/,
  /验收/,
  /推进/
];
const SeriesMeetingPatterns = [
  /指南/,
  /答疑/,
  /分享/,
  /课程/,
  /工作坊/,
  /训练营/,
  /专题/,
  /资源/,
  /方法论/,
  /核心信息/,
  /活动/
];
const QuestionPatterns = [
  /如何/,
  /怎么/,
  /是否/,
  /能否/,
  /什么/,
  /哪里/,
  /何时/,
  /什么时候/,
  /为什么/,
  /要不要/,
  /问[:：]/,
  /问题[:：]/,
  /疑问[:：]/
];
const AnswerPatterns = [
  /答[:：]/,
  /可以/,
  /需要/,
  /建议/,
  /方式/,
  /路径/,
  /入口/,
  /时间/,
  /资料/,
  /参考/,
  /准备/,
  /使用/
];

const ThemeCatalog: Array<{
  title: string;
  patterns: RegExp[];
  source_signals: KnowledgeBasePageSignal[];
}> = [
  {
    title: "赛事总览与核心指南",
    patterns: [
      /赛程/,
      /报名/,
      /规则/,
      /奖项/,
      /队伍/,
      /作品/,
      /评审/,
      /挑战/,
      /提交/,
      /资格/,
      /组队/,
      /活动安排/
    ],
    source_signals: ["always"]
  },
  {
    title: "技术资源与开发环境",
    patterns: [
      /技术/,
      /开发/,
      /环境/,
      /API/i,
      /SDK/i,
      /CLI/i,
      /MCP/i,
      /接口/,
      /部署/,
      /模型/,
      /权限/,
      /密钥/,
      /文档/,
      /工具/,
      /服务/
    ],
    source_signals: ["sources"]
  },
  {
    title: "产品设计与实战方法论",
    patterns: [
      /产品/,
      /用户/,
      /需求/,
      /场景/,
      /PRD/i,
      /原型/,
      /设计/,
      /方法论/,
      /调研/,
      /访谈/,
      /Demo/i,
      /演示/,
      /价值/,
      /痛点/
    ],
    source_signals: ["decisions", "sources"]
  },
  {
    title: "职场与 Offer 指南",
    patterns: [/职场/, /Offer/i, /招聘/, /实习/, /岗位/, /简历/, /面试/, /职业/, /校招/, /转正/],
    source_signals: ["sources"]
  },
  {
    title: "执行计划与责任分工",
    patterns: [/待办/, /负责人/, /排期/, /里程碑/, /截止/, /推进/, /交付/, /验收/, /任务/, /分工/],
    source_signals: ["actions", "calendars"]
  },
  {
    title: "资料与资产导航",
    patterns: [/资料/, /链接/, /文档/, /仓库/, /模板/, /案例/, /资源/, /素材/, /清单/],
    source_signals: ["sources"]
  },
  {
    title: "关键决策与风险",
    patterns: [/结论/, /决定/, /明确/, /风险/, /阻塞/, /不确定/, /待验证/],
    source_signals: ["decisions", "risks"]
  }
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

function uniqueSignals(values: KnowledgeBasePageSignal[]): KnowledgeBasePageSignal[] {
  return [...new Set(values)];
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

type MeetingRelationshipKind = "progressive_project" | "complementary_series" | "recurring_cycle";

type MeetingRelationship = {
  kind: MeetingRelationshipKind;
  label: string;
  rationale: string[];
};

type ThemeModule = {
  title: string;
  fragments: string[];
  sourceMeetings: string[];
  source_signals: KnowledgeBasePageSignal[];
};

type FaqItem = {
  question: string;
  answer: string;
  source: string;
};

type PageDraft = {
  label: string;
  page_type: KnowledgeBasePage["page_type"];
  source_signals: KnowledgeBasePageSignal[];
  renderMarkdown: (title: string) => string;
};

function meetingText(meeting: MeetingRow): string {
  return [
    meeting.title,
    meeting.summary ?? "",
    meeting.transcript_text,
    ...parseStringArray(meeting.keywords_json)
  ].join("\n");
}

function meetingsText(meetings: MeetingRow[]): string {
  return meetings.map(meetingText).join("\n");
}

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function patternHitCount(text: string, patterns: RegExp[]): number {
  return patterns.filter((pattern) => pattern.test(text)).length;
}

function collectThemeFragments(meetings: MeetingRow[], patterns: RegExp[]): string[] {
  return unique(
    meetings.flatMap((meeting) =>
      evidenceFragments(meetingText(meeting))
        .filter((fragment) => hasAnyPattern(fragment, patterns))
        .map((fragment) => `${meetingLabel(meeting)}：${formatOpenIdsInText(fragment)}`)
    )
  ).slice(0, 8);
}

function collectThemeMeetings(meetings: MeetingRow[], patterns: RegExp[]): string[] {
  return meetings
    .filter((meeting) => hasAnyPattern(meetingText(meeting), patterns))
    .map(meetingLabel);
}

function diagnoseMeetingRelationship(input: {
  meetings: MeetingRow[];
  actions: ActionItemRow[];
  calendars: CalendarDraftRow[];
  decisions: string[];
  risks: string[];
}): MeetingRelationship {
  const text = meetingsText(input.meetings);
  const recurringScore = patternHitCount(text, RecurringMeetingPatterns);
  const projectScore =
    patternHitCount(text, ProjectMeetingPatterns) +
    input.actions.length +
    input.calendars.length +
    input.decisions.length +
    input.risks.length;
  const seriesScore =
    patternHitCount(text, SeriesMeetingPatterns) +
    ThemeCatalog.filter((theme) => hasAnyPattern(text, theme.patterns)).length;

  if (input.meetings.length >= 2 && recurringScore >= 2) {
    return {
      kind: "recurring_cycle",
      label: "周期/例会型",
      rationale: ["多场会议呈现固定节奏或复盘同步信号", "保留变化、决策、待办和日程趋势"]
    };
  }

  if (input.meetings.length >= 2 && seriesScore >= Math.max(3, projectScore)) {
    return {
      kind: "complementary_series",
      label: "互补/系列型",
      rationale: ["多场会议从不同角度补齐同一主题", "优先按用户任务与知识模块组织"]
    };
  }

  return {
    kind: "progressive_project",
    label: "递进/项目型",
    rationale: ["会议内容围绕推进、交付、风险或后续动作展开", "保留行动、日程、决策和风险索引"]
  };
}

function fallbackThemeTitle(keywords: string[]): string {
  const keyword = keywords.find((value) => value.length > 0);
  return keyword ? `${keyword} / 任务指南` : "核心主题与用户任务";
}

function buildThemeModules(input: {
  meetings: MeetingRow[];
  actions: ActionItemRow[];
  calendars: CalendarDraftRow[];
  decisions: string[];
  risks: string[];
  keywords: string[];
  sources: string[];
}): ThemeModule[] {
  const modules = ThemeCatalog.map((theme) => ({
    title: theme.title,
    fragments: collectThemeFragments(input.meetings, theme.patterns),
    sourceMeetings: collectThemeMeetings(input.meetings, theme.patterns),
    source_signals: theme.source_signals
  }))
    .filter(
      (theme) =>
        theme.fragments.length > 0 ||
        (theme.title === "执行计划与责任分工" &&
          (input.actions.length > 0 || input.calendars.length > 0)) ||
        (theme.title === "资料与资产导航" && input.sources.length > 0) ||
        (theme.title === "关键决策与风险" && (input.decisions.length > 0 || input.risks.length > 0))
    )
    .map((theme) => {
      if (theme.title === "执行计划与责任分工") {
        return {
          ...theme,
          fragments: unique([
            ...theme.fragments,
            ...input.actions.map((action) => `待办：${action.title}`),
            ...input.calendars.map((calendar) => `日程：${calendar.title}`)
          ]).slice(0, 8)
        };
      }

      if (theme.title === "资料与资产导航") {
        return {
          ...theme,
          fragments: unique([
            ...theme.fragments,
            ...input.sources.map((source) => `资料：${source}`)
          ]).slice(0, 8)
        };
      }

      if (theme.title === "关键决策与风险") {
        return {
          ...theme,
          fragments: unique([
            ...theme.fragments,
            ...input.decisions.map((decision) => `决策：${decision}`),
            ...input.risks.map((risk) => `风险：${risk}`)
          ]).slice(0, 8)
        };
      }

      return theme;
    });

  if (modules.length > 0) {
    return modules;
  }

  return [
    {
      title: fallbackThemeTitle(input.keywords),
      fragments: input.meetings.map(
        (meeting) => `${meetingLabel(meeting)}：${meeting.summary ?? "暂无摘要"}`
      ),
      sourceMeetings: input.meetings.map(meetingLabel),
      source_signals: ["always"]
    }
  ];
}

function stripSpeakerPrefix(value: string): string {
  return formatOpenIdsInText(value)
    .replace(/^.{1,16}?(问|问题|疑问|答)[:：]\s*/, "")
    .replace(/^[^：:]{1,16}[:：]\s*/, "")
    .trim();
}

function isQuestionFragment(value: string): boolean {
  return hasAnyPattern(value, QuestionPatterns);
}

function normalizeQuestion(value: string): string {
  return stripSpeakerPrefix(value)
    .toLowerCase()
    .replace(/[？?。；;，,\s：:]/g, "")
    .trim();
}

function inferFaqAnswer(fragments: string[], index: number): string {
  const answer = fragments
    .slice(index + 1, index + 4)
    .map(stripSpeakerPrefix)
    .find((fragment) => fragment.length > 0 && hasAnyPattern(fragment, AnswerPatterns));

  return answer ?? "已合并到 Core Content 对应主题；必要时可回到 Archive 查看来源语境。";
}

function extractFaqItems(meetings: MeetingRow[], modules: ThemeModule[]): FaqItem[] {
  const seen = new Set<string>();
  const extracted = meetings.flatMap((meeting) => {
    const fragments = evidenceFragments(meetingText(meeting));
    return fragments.flatMap((fragment, index) => {
      if (!isQuestionFragment(fragment)) {
        return [];
      }

      const question = stripSpeakerPrefix(fragment);
      const key = normalizeQuestion(question);
      if (key.length < 3 || seen.has(key)) {
        return [];
      }

      seen.add(key);
      return [
        {
          question,
          answer: inferFaqAnswer(fragments, index),
          source: meetingLabel(meeting)
        }
      ];
    });
  });

  if (extracted.length > 0) {
    return extracted.slice(0, 12);
  }

  return [
    {
      question: "应该先看哪些主题？",
      answer: `先看 ${modules
        .slice(0, 3)
        .map((module) => module.title)
        .join("、")}，再按 Archive 追溯来源。`,
      source: "curator 合并规则"
    },
    {
      question: "如果不同会议说法不一致怎么办？",
      answer:
        "Dashboard 只保留当前可执行版本；差异和原始语境进入 Archive，等待后续会议或人工确认。",
      source: "curator 合并规则"
    }
  ];
}

function themeJobDescription(title: string): string {
  if (title.includes("赛事")) {
    return "了解参与路径、规则、关键节点和交付要求";
  }
  if (title.includes("技术")) {
    return "搭建环境、找到工具资料、确认接口与权限";
  }
  if (title.includes("产品")) {
    return "把需求、场景、原型和验证方法串成实战路径";
  }
  if (title.includes("Offer")) {
    return "理解职业发展、面试准备和岗位信息";
  }
  if (title.includes("执行")) {
    return "查看行动项、日程、负责人和推进状态";
  }
  if (title.includes("资料")) {
    return "定位文档、链接、模板和资产来源";
  }
  if (title.includes("决策")) {
    return "查看已确认口径、风险和待验证内容";
  }
  return "围绕该主题快速找到可执行信息";
}

function pageAnchor(title: string): string {
  return title.replace(/^\d+\s+/, "");
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
  const meetingsById = new Map(input.meetings.map((meeting) => [meeting.id, meeting]));
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
  const relationship = diagnoseMeetingRelationship({
    meetings: input.meetings,
    actions: input.actions,
    calendars: input.calendars,
    decisions,
    risks
  });
  const themeModules = buildThemeModules({
    meetings: input.meetings,
    actions: input.actions,
    calendars: input.calendars,
    decisions,
    risks,
    keywords: input.keywords,
    sources: input.sources
  });
  const faqItems = extractFaqItems(input.meetings, themeModules);
  const timelineSummary = timelineRows(input.meetings, input.calendars).map(
    ([stage, time, status, source]) => `${time}｜${stage}｜${status}｜${source}`
  );
  const shouldRenderExecutionPages =
    relationship.kind !== "complementary_series" ||
    actionIndex.length > 0 ||
    calendarIndex.length > 0 ||
    decisions.length > 0 ||
    risks.length > 0;
  const pageDrafts: PageDraft[] = [
    {
      label: CORE_CONTENT_LABEL,
      page_type: "index",
      source_signals: uniqueSignals(themeModules.flatMap((module) => module.source_signals)),
      renderMarkdown: (title) =>
        [
          `# ${title}`,
          "",
          "## 主题重组原则",
          `会议关系：${relationship.label}。${relationship.rationale.join("；")}。`,
          "",
          "## 模块总览",
          markdownTable(
            ["主题模块", "用户任务", "来源信号"],
            themeModules.map((module) => [
              module.title,
              themeJobDescription(module.title),
              module.sourceMeetings.length > 0 ? module.sourceMeetings.join("<br>") : "综合来源"
            ])
          ),
          "",
          ...themeModules.flatMap((module) => [
            `## ${module.title}`,
            "",
            "### 可执行信息",
            bulletList(module.fragments, "暂无可提炼内容"),
            "",
            "### 来源会议",
            bulletList(module.sourceMeetings, "综合多场会议信号"),
            ""
          ])
        ].join("\n")
    },
    {
      label: MERGED_FAQ_LABEL,
      page_type: "analysis",
      source_signals: ["always"],
      renderMarkdown: (title) =>
        [
          `# ${title}`,
          "",
          "## 去重规则",
          "同义问题只保留一条合并答案；答案引用当前 Core Content，来源语境保留在 Archive。",
          "",
          markdownTable(
            ["Question", "Merged Answer", "Sources"],
            faqItems.map((item) => [item.question, item.answer, item.source])
          )
        ].join("\n")
    },
    {
      label: ARCHIVE_LABEL,
      page_type: "sources",
      source_signals: ["always", "sources"],
      renderMarkdown: (title) =>
        [
          `# ${title}`,
          "",
          "## 活动回顾 / 来源索引",
          markdownTable(
            ["类型", "时间", "摘要", "来源"],
            [
              ...input.meetings.map((meeting) => [
                "会议",
                meeting.started_at ?? "待补充",
                meeting.summary ?? "暂无摘要",
                formatMeetingReference(meeting, {
                  preferredLink: "minutes",
                  hideInternalId: true
                })
              ]),
              ...input.sources.map((source) => ["资料", "待补充", source, `资料：${source}`])
            ]
          ),
          "",
          "## 主题到来源映射",
          markdownTable(
            ["主题模块", "来源会议", "证据片段"],
            themeModules.map((module) => [
              module.title,
              module.sourceMeetings.length > 0 ? module.sourceMeetings.join("<br>") : "综合来源",
              module.fragments.slice(0, 3).join("<br>")
            ])
          ),
          "",
          "## 转写记录",
          "会议全文不直接塞入模型上下文；这里仅保留转写记录引用。",
          "",
          bulletList(transcriptRefs, "暂无转写记录引用")
        ].join("\n")
    }
  ];

  if (shouldRenderExecutionPages) {
    pageDrafts.push(
      {
        label: PROJECT_BOARD_LABEL,
        page_type: "board",
        source_signals: ["actions", "decisions", "risks"],
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
            markdownTable(["优先级", "泳道", "状态", "完成度", "当前信号"], rows),
            "",
            "## 行动索引",
            bulletList(actionIndex, "暂无待办"),
            "",
            "## 决策",
            bulletList(decisions, "暂无关键结论与决策"),
            "",
            "## 风险",
            bulletList(risks, "暂无风险、问题与待验证假设")
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
      }
    );
  }

  if (calendarIndex.length > 0) {
    pageDrafts.push({
      label: CALENDAR_LABEL,
      page_type: "calendar",
      source_signals: ["calendars"],
      renderMarkdown: (title) =>
        [`# ${title}`, "", bulletList(calendarIndex, "暂无日程")].join("\n")
    });
  }

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
      "## Dashboard / Overview",
      `主题：${input.name}`,
      "",
      "## 核心目标",
      input.goal,
      "",
      "## 会议关系诊断",
      `${relationship.label}：${relationship.rationale.join("；")}。`,
      "",
      "## 关键时间轴",
      bulletList(timelineSummary, "暂无时间线"),
      "",
      "## 核心资产导航",
      bulletList(pageTitles.map(pageAnchor), "暂无结构"),
      "",
      "## 主题目录",
      bulletList(
        themeModules.map((module) => `${module.title}：${themeJobDescription(module.title)}`),
        "暂无主题模块"
      ),
      "",
      "## FAQ / Archive 入口",
      bulletList(
        [
          `${MERGED_FAQ_LABEL}：合并重复问题并保留当前答案`,
          `${ARCHIVE_LABEL}：保留来源会议、资料引用和转写记录`
        ],
        "暂无入口"
      ),
      "",
      "## 当前信号",
      bulletList(signalSummary, "暂无内容信号"),
      "",
      "## SSOT 校验",
      bulletList(
        [
          "Dashboard 只呈现当前可信入口，不堆叠会议流水账",
          "Core Content 按用户任务组织，重复信息只保留一次",
          "Merged FAQ 合并同义问题，Archive 保留可追溯来源",
          "行动与日程索引保留来源会议，不替代确认流程"
        ],
        "暂无校验项"
      ),
      "",
      "## 关键链接 / 来源",
      bulletList([...meetingRefs, ...input.sources.map((source) => `资料：${source}`)], "暂无来源"),
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
  const goal = `沉淀 ${input.topicName} 相关会议结论、执行事项、日程和来源资料，形成${workspaceName}可持续更新、按用户任务组织的主题式 SSOT。`;
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
    description: `由 ${input.meetings.length} 场相关会议 dry-run 创建的主题式知识库。`,
    owner: input.owner,
    status: "active",
    confidence_origin: input.confidenceOrigin,
    related_keywords: keywords,
    created_from_meetings: input.meetings.map((meeting) => meeting.id),
    pages
  });
}
