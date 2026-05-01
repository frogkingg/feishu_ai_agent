import {
  KnowledgeBaseDraft,
  KnowledgeBaseDraftSchema,
  KnowledgeBasePage,
  KnowledgeBasePageSignal
} from "../schemas";
import { LlmClient } from "../services/llm/llmClient";
import { ActionItemRow, CalendarDraftRow, MeetingRow } from "../services/store/repositories";
import {
  formatMeetingReference,
  formatOpenIdsInText,
  formatUserForDisplay,
  formatUserListForDisplay
} from "../utils/display";
import { stableDemoId } from "../utils/id";
import { personalWorkspaceName } from "../utils/personalWorkspace";
import { readPrompt } from "../utils/prompts";

const README_LABEL = "README / Dashboard";
const CORE_CONTENT_LABEL = "Core Content / 主题模块";
const MERGED_FAQ_LABEL = "Merged FAQ / 问题合并";
const ARCHIVE_LABEL = "Archive / 来源追溯";
const PROJECT_BOARD_LABEL = "Project Board / 行动与风险";
const TIMELINE_LABEL = "Timeline / 时间轴与日程";
const CALENDAR_LABEL = "Calendar / 日程索引";

type CuratorContext = {
  topicName: string;
  owner: string | null;
  goal: string;
  description: string;
  confidenceOrigin: number;
  keywords: string[];
  meetings: MeetingRow[];
  actions: ActionItemRow[];
  calendars: CalendarDraftRow[];
};

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

function numberedTitle(index: number, label: string): string {
  return `${index.toString().padStart(2, "0")} ${label}`;
}

function bulletList(values: string[], fallback: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function markdownTable(headers: string[], rows: string[][]): string {
  const escapeCell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)
  ].join("\n");
}

function firstNonEmpty(values: Array<unknown>, fallback: string): string {
  const match = values.find((value) => typeof value === "string" && value.trim().length > 0);
  return typeof match === "string" ? match.trim() : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.filter((item): item is string => typeof item === "string"))
    : [];
}

function safePageSignals(value: unknown): KnowledgeBasePageSignal[] {
  const allowed = new Set<KnowledgeBasePageSignal>([
    "always",
    "actions",
    "calendars",
    "decisions",
    "risks",
    "sources"
  ]);
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value.filter((item): item is KnowledgeBasePageSignal =>
        allowed.has(item as KnowledgeBasePageSignal)
      )
    )
  ];
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
    const participants = formatUserListForDisplay(parseStringArray(calendar.participants_json));
    const participantText = participants.length > 0 ? `，参与人 ${participants.join("、")}` : "";
    return `${calendar.title}${time}${participantText}（来源${sourceMeetingReference(
      meetingsById,
      calendar.meeting_id
    )}）`;
  });
}

function meetingReference(meeting: MeetingRow, preferredLink: "minutes" | "transcript"): string {
  return formatMeetingReference(meeting, {
    preferredLink,
    hideInternalId: true
  });
}

function transcriptReference(meeting: MeetingRow): string {
  if (meeting.transcript_url || meeting.minutes_url) {
    return meetingReference(meeting, "transcript");
  }

  return `${meeting.title}（${meeting.started_at ?? "时间待补充"}，本地转写记录未写入知识库正文）`;
}

function compactText(value: string | null, fallback: string): string {
  const text = formatOpenIdsInText(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) {
    return fallback;
  }
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function buildContext(input: {
  topicName: string;
  owner: string | null;
  meetings: MeetingRow[];
  actions: ActionItemRow[];
  calendars: CalendarDraftRow[];
  confidenceOrigin: number;
}): CuratorContext {
  const keywords = unique(
    input.meetings.flatMap((meeting) => parseStringArray(meeting.keywords_json))
  );
  const workspaceName = personalWorkspaceName();
  const goal = `沉淀 ${input.topicName} 相关会议结论、执行事项、日程和来源资料，形成${workspaceName}可持续更新、由 LLM 策展的主题式 SSOT。`;

  return {
    topicName: input.topicName,
    owner: input.owner,
    goal,
    description: `由 ${input.meetings.length} 场相关会议 dry-run 创建的 LLM 策展知识库。`,
    confidenceOrigin: input.confidenceOrigin,
    keywords,
    meetings: input.meetings,
    actions: input.actions,
    calendars: input.calendars
  };
}

function buildCuratorDigest(context: CuratorContext): Record<string, unknown> {
  const meetingsById = new Map(context.meetings.map((meeting) => [meeting.id, meeting]));

  return {
    curator_contract: {
      role: "MeetingAtlas Knowledge Curator",
      decision_owner: "LLM follows knowledgeCurator.md and the MeetingAtlas Skill",
      code_boundary:
        "Code only provides compact meeting digest, action/calendar/source signals, schema validation, and Feishu write orchestration.",
      safety:
        "Do not include full transcript text. Preserve source traceability through meeting references and transcript links."
    },
    topic: {
      name: context.topicName,
      goal: context.goal,
      owner: context.owner,
      confidence_origin: context.confidenceOrigin,
      keywords: context.keywords
    },
    meetings: context.meetings.map((meeting, index) => ({
      source_ref: `M${index + 1}`,
      title: meeting.title,
      started_at: meeting.started_at,
      ended_at: meeting.ended_at,
      organizer: meeting.organizer,
      participants: formatUserListForDisplay(parseStringArray(meeting.participants_json)),
      summary: compactText(meeting.summary, "暂无摘要"),
      keywords: parseStringArray(meeting.keywords_json),
      minutes_reference: meetingReference(meeting, "minutes"),
      transcript_reference: transcriptReference(meeting)
    })),
    actions: context.actions.map((action) => ({
      title: action.title,
      description: action.description,
      owner: action.owner,
      due_date: action.due_date,
      priority: action.priority,
      evidence: compactText(action.evidence, "暂无证据"),
      source: sourceMeetingReference(meetingsById, action.meeting_id)
    })),
    calendars: context.calendars.map((calendar) => ({
      title: calendar.title,
      start_time: calendar.start_time,
      end_time: calendar.end_time,
      participants: formatUserListForDisplay(parseStringArray(calendar.participants_json)),
      agenda: calendar.agenda,
      evidence: compactText(calendar.evidence, "暂无证据"),
      source: sourceMeetingReference(meetingsById, calendar.meeting_id)
    }))
  };
}

function buildCuratorUserPrompt(context: CuratorContext): string {
  return [
    "请根据以下多会议 digest 生成一个 KnowledgeBaseDraft JSON。",
    "你可以自由决定页面数量、页面标题和栏目，只要满足 schema、读者任务、SSOT 和 Archive 可追溯要求。",
    "不要输出完整 transcript，不要把会议逐字稿塞进正文。",
    "JSON schema 摘要：",
    JSON.stringify(
      {
        kb_id: "string",
        name: "string",
        goal: "string|null",
        description: "string|null",
        owner: "string|null",
        status: "candidate|active|archived",
        confidence_origin: "number 0..1",
        related_keywords: "string[]",
        created_from_meetings: "string[]",
        pages: [
          {
            title: "string",
            page_type:
              "home|index|analysis|board|timeline|calendar|sources|resources|risks|changelog|meeting_summary|transcript|goal|progress|decisions|meetings",
            source_signals: "always|actions|calendars|decisions|risks|sources[]",
            markdown: "string"
          }
        ]
      },
      null,
      2
    ),
    "digest:",
    JSON.stringify(buildCuratorDigest(context), null, 2)
  ].join("\n\n");
}

function normalizeLlmPages(rawPages: unknown): KnowledgeBasePage[] {
  if (!Array.isArray(rawPages)) {
    return [];
  }

  return rawPages
    .map((page, index) => {
      const record = asRecord(page);
      const title = firstNonEmpty([record.title], numberedTitle(index, CORE_CONTENT_LABEL));
      const markdown = firstNonEmpty([record.markdown, record.content], `# ${title}`);
      return {
        title,
        page_type: firstNonEmpty([record.page_type], index === 0 ? "home" : "index"),
        source_signals: safePageSignals(record.source_signals),
        markdown
      };
    })
    .filter((page) => page.markdown.trim().length > 0) as KnowledgeBasePage[];
}

function normalizeLlmDraft(raw: unknown, context: CuratorContext): KnowledgeBaseDraft {
  const record = asRecord(raw);
  const pages = normalizeLlmPages(record.pages);
  if (pages.length === 0) {
    throw new Error("Knowledge curator LLM returned no pages");
  }

  return KnowledgeBaseDraftSchema.parse({
    kb_id: stableDemoId("kb", context.topicName),
    name: firstNonEmpty([record.name], context.topicName),
    goal: firstNonEmpty([record.goal], context.goal),
    description: firstNonEmpty([record.description], context.description),
    owner: typeof record.owner === "string" ? record.owner : context.owner,
    status: "active",
    confidence_origin:
      typeof record.confidence_origin === "number"
        ? Math.max(0, Math.min(1, record.confidence_origin))
        : context.confidenceOrigin,
    related_keywords: unique([...context.keywords, ...safeStringArray(record.related_keywords)]),
    created_from_meetings: context.meetings.map((meeting) => meeting.id),
    pages
  });
}

function buildFallbackPages(context: CuratorContext): KnowledgeBasePage[] {
  const meetingsById = new Map(context.meetings.map((meeting) => [meeting.id, meeting]));
  const meetingRefs = context.meetings.map((meeting) => meetingReference(meeting, "minutes"));
  const transcriptRefs = context.meetings.map(transcriptReference);
  const actionIndex = renderActionIndex(context.actions, meetingsById);
  const calendarIndex = renderCalendarIndex(context.calendars, meetingsById);
  const meetingRows = context.meetings.map((meeting) => [
    meeting.started_at ?? "待补充",
    meeting.title,
    compactText(meeting.summary, "暂无摘要"),
    meetingReference(meeting, "minutes")
  ]);
  const signalRows = [
    ["会议", `${context.meetings.length} 场`, "Archive 保留来源入口"],
    ["待办", `${actionIndex.length} 项`, "Project Board 只索引确认前草案"],
    ["日程", `${calendarIndex.length} 项`, "Calendar 只索引确认前草案"],
    ["关键词", context.keywords.join("、") || "待 LLM 补齐", "来自会议抽取结果"]
  ];
  const pages: KnowledgeBasePage[] = [
    {
      title: numberedTitle(0, README_LABEL),
      page_type: "home",
      source_signals: ["always"],
      markdown: [
        `# ${numberedTitle(0, README_LABEL)}`,
        "",
        "## Dashboard / Overview",
        context.goal,
        "",
        "## 当前信号",
        markdownTable(["信号", "数量 / 内容", "使用方式"], signalRows),
        "",
        "## 读者入口",
        bulletList(
          [
            `${CORE_CONTENT_LABEL}：先给出当前可读版本，等待 LLM 进一步策展`,
            `${MERGED_FAQ_LABEL}：只保留待确认问题入口，不做代码分类`,
            `${ARCHIVE_LABEL}：保留会议、摘要、转写引用和来源映射`
          ],
          "暂无入口"
        ),
        "",
        "## 来源范围",
        bulletList(meetingRefs, "暂无会议来源")
      ].join("\n")
    },
    {
      title: numberedTitle(1, CORE_CONTENT_LABEL),
      page_type: "index",
      source_signals: ["always"],
      markdown: [
        `# ${numberedTitle(1, CORE_CONTENT_LABEL)}`,
        "",
        "## 当前可读版本",
        "这是 deterministic fallback。正式结构、栏目和优先级由 LLM 根据 Skill 策展。",
        "",
        "## 会议摘要",
        markdownTable(["时间", "会议", "摘要", "来源"], meetingRows),
        "",
        "## 下一步",
        bulletList(
          [
            ...actionIndex.slice(0, 6),
            ...calendarIndex.slice(0, 6),
            "让 LLM 根据会议关系重组 Dashboard、主题页、FAQ 与 Archive"
          ],
          "暂无行动或日程信号"
        )
      ].join("\n")
    },
    {
      title: numberedTitle(2, MERGED_FAQ_LABEL),
      page_type: "analysis",
      source_signals: ["always"],
      markdown: [
        `# ${numberedTitle(2, MERGED_FAQ_LABEL)}`,
        "",
        "## 待 LLM 策展",
        "fallback 不按关键词分类 FAQ；只保留问题合并入口，避免用规则替代模型判断。",
        "",
        markdownTable(
          ["Question", "Current Answer", "Sources"],
          [
            [
              "这些会议应该如何阅读？",
              "先看 Dashboard，再按主题页阅读，必要时回 Archive 追溯。",
              meetingRefs.join("<br>")
            ]
          ]
        )
      ].join("\n")
    },
    {
      title: numberedTitle(3, ARCHIVE_LABEL),
      page_type: "sources",
      source_signals: ["always", "sources"],
      markdown: [
        `# ${numberedTitle(3, ARCHIVE_LABEL)}`,
        "",
        "## 来源索引",
        markdownTable(["时间", "会议", "摘要", "来源"], meetingRows),
        "",
        "## 转写引用",
        bulletList(transcriptRefs, "暂无转写记录引用"),
        "",
        "## 主题到来源映射",
        "由 LLM 在正式策展时生成；fallback 只保留来源，不做主题归类。"
      ].join("\n")
    }
  ];

  if (actionIndex.length > 0) {
    pages.push({
      title: numberedTitle(pages.length, PROJECT_BOARD_LABEL),
      page_type: "board",
      source_signals: ["actions"],
      markdown: [
        `# ${numberedTitle(pages.length, PROJECT_BOARD_LABEL)}`,
        "",
        "## 行动索引",
        bulletList(actionIndex, "暂无待办")
      ].join("\n")
    });
  }

  if (context.meetings.length > 0) {
    pages.push({
      title: numberedTitle(pages.length, TIMELINE_LABEL),
      page_type: "timeline",
      source_signals: ["always", "calendars"],
      markdown: [
        `# ${numberedTitle(pages.length, TIMELINE_LABEL)}`,
        "",
        markdownTable(["时间", "会议", "摘要", "来源"], meetingRows)
      ].join("\n")
    });
  }

  if (calendarIndex.length > 0) {
    pages.push({
      title: numberedTitle(pages.length, CALENDAR_LABEL),
      page_type: "calendar",
      source_signals: ["calendars"],
      markdown: [
        `# ${numberedTitle(pages.length, CALENDAR_LABEL)}`,
        "",
        bulletList(calendarIndex, "暂无日程")
      ].join("\n")
    });
  }

  return pages;
}

function buildFallbackDraft(context: CuratorContext): KnowledgeBaseDraft {
  return KnowledgeBaseDraftSchema.parse({
    kb_id: stableDemoId("kb", context.topicName),
    name: context.topicName,
    goal: context.goal,
    description: context.description,
    owner: context.owner,
    status: "active",
    confidence_origin: context.confidenceOrigin,
    related_keywords: context.keywords,
    created_from_meetings: context.meetings.map((meeting) => meeting.id),
    pages: buildFallbackPages(context)
  });
}

export function renderKnowledgeBaseMarkdown(draft: KnowledgeBaseDraft): string {
  return draft.pages.map((page) => page.markdown).join("\n\n---\n\n");
}

export async function runKnowledgeCuratorAgent(input: {
  topicName: string;
  owner: string | null;
  meetings: MeetingRow[];
  actions: ActionItemRow[];
  calendars: CalendarDraftRow[];
  confidenceOrigin: number;
  llm?: LlmClient;
}): Promise<KnowledgeBaseDraft> {
  const context = buildContext(input);
  if (!input.llm) {
    return buildFallbackDraft(context);
  }

  try {
    const raw = await input.llm.generateJson<unknown>({
      systemPrompt: readPrompt("knowledgeCurator.md"),
      userPrompt: buildCuratorUserPrompt(context),
      schemaName: "KnowledgeBaseDraft"
    });
    return normalizeLlmDraft(raw, context);
  } catch {
    return buildFallbackDraft(context);
  }
}
