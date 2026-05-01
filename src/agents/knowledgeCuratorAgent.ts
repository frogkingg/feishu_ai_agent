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

const HOME_LABEL = "首页 / 总览";
const GOAL_LABEL = "整体目标";
const ANALYSIS_LABEL = "整体分析";
const PROGRESS_LABEL = "当前进度";
const DECISIONS_LABEL = "关键结论与决策";
const ACTION_CALENDAR_LABEL = "待办与日程索引";
const MEETINGS_LABEL = "会议索引";
const TRANSCRIPT_LABEL = "转写引用";
const RESOURCES_LABEL = "关联资料";
const RISKS_LABEL = "风险与假设";
const CHANGELOG_LABEL = "变更记录";
const MeetingSummaryLimit = 900;
const TranscriptExcerptLimit = 1000;
const EvidenceLimit = 500;

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

function compactText(value: string | null, fallback: string, maxLength: number): string {
  const text = formatOpenIdsInText(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) {
    return fallback;
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function compactJson(value: unknown, maxLength: number): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function meetingSummary(meeting: MeetingRow): string {
  return compactText(meeting.summary, "暂无摘要", MeetingSummaryLimit);
}

function transcriptExcerpt(meeting: MeetingRow): string {
  return compactText(meeting.transcript_text, "暂无转写摘录", TranscriptExcerptLimit);
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
    description: `由 ${input.meetings.length} 场相关会议创建的主题知识库。`,
    confidenceOrigin: input.confidenceOrigin,
    keywords,
    meetings: input.meetings,
    actions: input.actions,
    calendars: input.calendars
  };
}

function buildCuratorDigest(context: CuratorContext): Record<string, unknown> {
  const meetingsById = new Map(context.meetings.map((meeting) => [meeting.id, meeting]));
  const sourceMap = context.meetings.map((meeting, index) => ({
    source_ref: `M${index + 1}`,
    meeting_title: meeting.title,
    minutes_reference: meetingReference(meeting, "minutes"),
    transcript_reference: transcriptReference(meeting)
  }));

  return {
    curator_contract: {
      role: "MeetingAtlas Knowledge Curator",
      decision_owner: "LLM follows knowledgeCurator.md and the MeetingAtlas Skill",
      code_boundary:
        "Code only provides compact meeting digest, action/calendar/source signals, schema validation, and Feishu write orchestration.",
      safety:
        "Do not include full transcript text. Preserve source traceability through meeting references and transcript links."
    },
    prd_page_structure: [
      "00 首页/总览：必须回答当前状态、下一步、关键结论、未解决问题",
      "01 整体目标：说明主题目标、读者对象、成功口径和待确认边界",
      "02 整体分析：跨会议综合分析，不按会议顺序堆叠",
      "03 当前进度：阶段、已完成、进行中、阻塞和下一步",
      "04 关键结论与决策：结论、依据、来源会议、置信度或待确认",
      "05 待办与日程索引：只索引待确认草案，不替代 confirmation 流程",
      "单会总结：每场会议至少有独立 summary 页或清晰会议索引",
      "转写引用：只保留链接和必要摘录，不写入全文",
      "关联资料：列出纪要、外部资料、来源引用和用途",
      "风险与假设：风险、缺口、假设、验证方式和来源",
      "变更记录：记录知识库创建与后续更新"
    ],
    topic: {
      name: context.topicName,
      goal: context.goal,
      owner: context.owner,
      confidence_origin: context.confidenceOrigin,
      keywords: context.keywords
    },
    existing_knowledge_base: {
      mode: "create_new",
      existing_pages: []
    },
    meetings: context.meetings.map((meeting, index) => ({
      source_ref: `M${index + 1}`,
      title: meeting.title,
      started_at: meeting.started_at,
      ended_at: meeting.ended_at,
      organizer: meeting.organizer,
      participants: formatUserListForDisplay(parseStringArray(meeting.participants_json)),
      summary: meetingSummary(meeting),
      keywords: parseStringArray(meeting.keywords_json),
      transcript_excerpt: transcriptExcerpt(meeting),
      minutes_reference: meetingReference(meeting, "minutes"),
      transcript_reference: transcriptReference(meeting)
    })),
    decision_and_risk_context: {
      persisted_decisions: [],
      persisted_risks: [],
      note:
        "当前仓库存储层没有独立保存 key_decisions/risks；请从会议摘要、转写摘录、行动证据和日程证据中综合判断关键结论、风险与假设，并在页面中标记来源。"
    },
    actions: context.actions.map((action) => ({
      title: action.title,
      description: action.description,
      owner: action.owner,
      collaborators: formatUserListForDisplay(parseStringArray(action.collaborators_json)),
      due_date: action.due_date,
      priority: action.priority,
      evidence: compactText(action.evidence, "暂无证据", EvidenceLimit),
      suggested_reason: action.suggested_reason,
      missing_fields: parseStringArray(action.missing_fields_json),
      confirmation_status: action.confirmation_status,
      source: sourceMeetingReference(meetingsById, action.meeting_id)
    })),
    calendars: context.calendars.map((calendar) => ({
      title: calendar.title,
      start_time: calendar.start_time,
      end_time: calendar.end_time,
      duration_minutes: calendar.duration_minutes,
      participants: formatUserListForDisplay(parseStringArray(calendar.participants_json)),
      agenda: calendar.agenda,
      location: calendar.location,
      evidence: compactText(calendar.evidence, "暂无证据", EvidenceLimit),
      missing_fields: parseStringArray(calendar.missing_fields_json),
      confirmation_status: calendar.confirmation_status,
      source: sourceMeetingReference(meetingsById, calendar.meeting_id)
    })),
    source_mapping: sourceMap
  };
}

function buildCuratorUserPrompt(context: CuratorContext): string {
  return [
    "请根据以下多会议 digest 生成一个 KnowledgeBaseDraft JSON。",
    "页面结构、栏目取舍和跨会议判断由你完成；代码只负责提供上下文、schema 和写入 draft.pages。",
    "请按 PRD 信息架构组织知识库：00 首页/总览、01 整体目标、02 整体分析、03 当前进度、04 关键结论与决策、05 待办与日程索引，并补齐单会总结、转写引用、关联资料、风险与假设、变更记录。",
    "首页必须包含：当前状态、下一步、关键结论、未解决问题。它不是 README 模板。",
    "每场会议至少要有独立 summary 页，或者在会议索引中给出清晰、可深化的单会摘要和来源映射。",
    "不要输出完整 transcript，不要把会议逐字稿塞进正文；只使用 transcript_excerpt 做必要证据摘录，并保留 transcript_reference。",
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
              "home|goal|analysis|progress|decisions|index|meeting_summary|transcript|board|timeline|meetings|resources|calendar|sources|risks|changelog",
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

function buildRepairUserPrompt(input: {
  context: CuratorContext;
  previousOutput: unknown;
  validationError: unknown;
}): string {
  return [
    "你上一次输出没有通过 KnowledgeBaseDraft schema 校验。请进行一次 schema repair。",
    "只返回完整、可解析的 KnowledgeBaseDraft JSON；不要输出解释文字、Markdown fence 或额外前后缀。",
    "修复边界：保留来源事实和会议判断，不新增代码模板；只补齐缺失字段、修正 page_type/source_signals、保证 pages 至少 1 页且每页 markdown 非空。",
    "validation_error:",
    errorText(input.validationError),
    "previous_output:",
    compactJson(input.previousOutput, 4000),
    "原始生成任务与 digest:",
    buildCuratorUserPrompt(input.context)
  ].join("\n\n");
}

function normalizeLlmPages(rawPages: unknown): KnowledgeBasePage[] {
  if (!Array.isArray(rawPages)) {
    return [];
  }

  return rawPages
    .map((page, index) => {
      const record = asRecord(page);
      const title = firstNonEmpty([record.title], numberedTitle(index, ANALYSIS_LABEL));
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
    meetingSummary(meeting),
    meetingReference(meeting, "minutes")
  ]);
  const meetingSummaryPages = context.meetings.map<KnowledgeBasePage>((meeting, index) => ({
    title: numberedTitle(7 + index, `会议总结 / M${index + 1} ${meeting.title}`),
    page_type: "meeting_summary",
    source_signals: ["always", "sources"],
    markdown: [
      `# ${numberedTitle(7 + index, `会议总结 / M${index + 1} ${meeting.title}`)}`,
      "",
      "## 会议摘要",
      meetingSummary(meeting),
      "",
      "## 必要摘录",
      transcriptExcerpt(meeting),
      "",
      "## 来源",
      `- 纪要：${meetingReference(meeting, "minutes")}`,
      `- 转写：${transcriptReference(meeting)}`
    ].join("\n")
  }));
  const pages: KnowledgeBasePage[] = [
    {
      title: numberedTitle(0, HOME_LABEL),
      page_type: "home",
      source_signals: ["always"],
      markdown: [
        `# ${numberedTitle(0, HOME_LABEL)}`,
        "",
        "## 当前状态",
        `已收集 ${context.meetings.length} 场会议、${actionIndex.length} 个待办草案、${calendarIndex.length} 个日程草案，形成当前主题的初始知识范围。`,
        "",
        "## 下一步",
        bulletList(
          [...actionIndex.slice(0, 4), ...calendarIndex.slice(0, 2)],
          "继续补充会议材料，并确认后续待办、日程和来源资料"
        ),
        "",
        "## 关键结论",
        bulletList(
          context.meetings.map((meeting) => `${meeting.title}：${meetingSummary(meeting)}`),
          "暂无会议结论"
        ),
        "",
        "## 未解决问题",
        bulletList(
          [
            "尚未确认的风险、假设和冲突需要结合后续会议来源继续补充",
            "待确认哪些行动项和日程最终由用户执行"
          ],
          "暂无未解决问题"
        ),
        "",
        "## 来源范围",
        bulletList(meetingRefs, "暂无会议来源")
      ].join("\n")
    },
    {
      title: numberedTitle(1, GOAL_LABEL),
      page_type: "goal",
      source_signals: ["always"],
      markdown: [
        `# ${numberedTitle(1, GOAL_LABEL)}`,
        "",
        "## 目标",
        context.goal,
        "",
        "## 读者对象",
        "需要快速理解会议沉淀、执行下一步、追溯来源的人。",
        "",
        "## 成功口径",
        "读者能从首页进入目标、分析、进度、决策、待办日程、单会摘要和来源追溯。"
      ].join("\n")
    },
    {
      title: numberedTitle(2, ANALYSIS_LABEL),
      page_type: "analysis",
      source_signals: ["always"],
      markdown: [
        `# ${numberedTitle(2, ANALYSIS_LABEL)}`,
        "",
        "## 整体分析",
        "当前根据会议摘要、行动证据、日程证据和必要摘录形成初版综合分析。后续更新应继续补充跨会议结论、冲突点和来源依据。",
        "",
        markdownTable(["时间", "会议", "摘要", "来源"], meetingRows)
      ].join("\n")
    },
    {
      title: numberedTitle(3, PROGRESS_LABEL),
      page_type: "progress",
      source_signals: ["always", "actions", "calendars"],
      markdown: [
        `# ${numberedTitle(3, PROGRESS_LABEL)}`,
        "",
        "## 已沉淀",
        bulletList(context.meetings.map((meeting) => meeting.title), "暂无会议"),
        "",
        "## 进行中 / 下一步",
        bulletList([...actionIndex, ...calendarIndex], "暂无待办或日程信号")
      ].join("\n")
    },
    {
      title: numberedTitle(4, DECISIONS_LABEL),
      page_type: "decisions",
      source_signals: ["decisions", "sources"],
      markdown: [
        `# ${numberedTitle(4, DECISIONS_LABEL)}`,
        "",
        "## 关键结论与决策",
        bulletList(
          context.meetings.map((meeting) => `${meeting.title}：${meetingSummary(meeting)}`),
          "暂无可确认结论"
        ),
        "",
        "## 说明",
        "未在来源中确认的内容保持待确认；新增结论需要保留对应会议、摘录或行动证据。"
      ].join("\n")
    },
    {
      title: numberedTitle(5, ACTION_CALENDAR_LABEL),
      page_type: "board",
      source_signals: ["actions", "calendars"],
      markdown: [
        `# ${numberedTitle(5, ACTION_CALENDAR_LABEL)}`,
        "",
        "## 待办索引",
        bulletList(actionIndex, "暂无待办"),
        "",
        "## 日程索引",
        bulletList(calendarIndex, "暂无日程")
      ].join("\n")
    },
    {
      title: numberedTitle(6, MEETINGS_LABEL),
      page_type: "meetings",
      source_signals: ["always", "sources"],
      markdown: [
        `# ${numberedTitle(6, MEETINGS_LABEL)}`,
        "",
        markdownTable(["时间", "会议", "摘要", "来源"], meetingRows)
      ].join("\n")
    },
    ...meetingSummaryPages,
    {
      title: numberedTitle(7 + meetingSummaryPages.length, TRANSCRIPT_LABEL),
      page_type: "transcript",
      source_signals: ["sources"],
      markdown: [
        `# ${numberedTitle(7 + meetingSummaryPages.length, TRANSCRIPT_LABEL)}`,
        "",
        "## 转写引用",
        bulletList(transcriptRefs, "暂无转写记录引用"),
        "",
        "## 写入边界",
        "知识库正文不写入完整转写，只保留引用和必要摘录。"
      ].join("\n")
    },
    {
      title: numberedTitle(8 + meetingSummaryPages.length, RESOURCES_LABEL),
      page_type: "resources",
      source_signals: ["sources"],
      markdown: [
        `# ${numberedTitle(8 + meetingSummaryPages.length, RESOURCES_LABEL)}`,
        "",
        "## 关联资料",
        bulletList(meetingRefs, "暂无关联资料")
      ].join("\n")
    },
    {
      title: numberedTitle(9 + meetingSummaryPages.length, RISKS_LABEL),
      page_type: "risks",
      source_signals: ["risks", "sources"],
      markdown: [
        `# ${numberedTitle(9 + meetingSummaryPages.length, RISKS_LABEL)}`,
        "",
        "## 风险与假设",
        "请在后续会议中持续补充风险、假设、验证方式和来源。当前未确认的风险不直接升级为结论。"
      ].join("\n")
    },
    {
      title: numberedTitle(10 + meetingSummaryPages.length, CHANGELOG_LABEL),
      page_type: "changelog",
      source_signals: ["always"],
      markdown: [
        `# ${numberedTitle(10 + meetingSummaryPages.length, CHANGELOG_LABEL)}`,
        "",
        "## 变更记录",
        `- 创建知识库草案：${context.meetings.length} 场会议进入初始范围。`
      ].join("\n")
    }
  ];

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

  const systemPrompt = readPrompt("knowledgeCurator.md");
  let previousOutput: unknown = null;
  try {
    previousOutput = await input.llm.generateJson<unknown>({
      systemPrompt,
      userPrompt: buildCuratorUserPrompt(context),
      schemaName: "KnowledgeBaseDraft"
    });
    return normalizeLlmDraft(previousOutput, context);
  } catch (validationError) {
    try {
      const repaired = await input.llm.generateJson<unknown>({
        systemPrompt,
        userPrompt: buildRepairUserPrompt({ context, previousOutput, validationError }),
        schemaName: "KnowledgeBaseDraft"
      });
      return normalizeLlmDraft(repaired, context);
    } catch {
      return buildFallbackDraft(context);
    }
  }
}
