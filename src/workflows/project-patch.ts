import { callStructuredLlm } from "../llm/client";
import { buildProjectToolPrompt, buildProjectToolUserPayload } from "../llm/prompts";
import {
  ChatContext,
  GroundingEvidence,
  NormalizedMessageEvent,
  Project,
  ProjectPatchDecision,
  ProjectPatchAction,
  ProjectTask,
  RouterDecision,
} from "../llm/schemas";
import { stripBotMentions } from "../agent/router";

function defaultGrounding(event: NormalizedMessageEvent): GroundingEvidence {
  return {
    messageIds: event.messageId ? [event.messageId] : [],
    evidenceTexts: [stripBotMentions(event.text)].filter(Boolean),
  };
}

function emptyPatch(action: ProjectPatchAction, event: NormalizedMessageEvent): ProjectPatchDecision {
  return {
    action,
    projectMatch: { confidence: 0 },
    assistantReply: "",
    missingFields: [],
    requiresConfirmation: action !== "none",
    grounding: defaultGrounding(event),
  };
}

function normalizeText(event: NormalizedMessageEvent) {
  return stripBotMentions(event.text).replace(/\s+/g, " ").trim();
}

function extractProjectName(text: string) {
  const byVerb = text.match(/(?:要做|做一个|启动|立项|新建|创建)\s*([^，,。；;\n]+?)(?:，|,|。|；|;|目标|$)/);
  if (byVerb?.[1]) {
    return byVerb[1].replace(/^一个/, "").trim();
  }
  const byDemo = text.match(/([A-Za-z0-9_\-\u4e00-\u9fa5 ]{2,50}(?:Demo|项目领航员|项目))/i);
  return byDemo?.[1]?.trim();
}

function extractGoal(text: string) {
  return text.match(/目标[是：:]\s*([^，,。；;\n]+)/)?.[1]?.trim();
}

function extractMembers(text: string) {
  const members: Array<{ name: string; role?: string; evidenceText?: string }> = [];
  const matcher = /([A-Za-z][\w-]*|[\u4e00-\u9fa5]{2,4})\s*负责([^，,。；;\n]+)/g;
  for (const match of text.matchAll(matcher)) {
    members.push({
      name: match[1].trim(),
      role: match[2].trim(),
      evidenceText: match[0],
    });
  }
  return members;
}

function splitTaskSegments(text: string) {
  const cleaned = text.replace(/^刚才结论[:：]?/, "").trim();
  return cleaned
    .split(/[，,。；;]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function extractDue(segment: string) {
  return segment.match(/(今天|今晚|明早|明天|明晚|后天|周[一二三四五六日天]|下周[一二三四五六日天]?|周五前|下周五前|晚上|上午|下午)/)?.[1];
}

const PSEUDO_OWNERS = new Set([
  "我",
  "我们",
  "大家",
  "今天",
  "今晚",
  "明早",
  "明天",
  "明晚",
  "后天",
  "上午",
  "下午",
  "晚上",
  "一起",
]);

const TASK_OBJECT_OWNER_TOKENS = [
  "入口",
  "脚本",
  "需求",
  "PRD",
  "文档",
  "项目",
  "状态",
  "风险",
  "任务",
  "卡片",
  "接口",
  "页面",
  "流程",
  "逻辑",
  "功能",
  "Demo",
  "机器人",
];

function isTaskObjectOwner(value?: string) {
  const normalized = value?.trim();
  return Boolean(
    normalized &&
      TASK_OBJECT_OWNER_TOKENS.some(
        (token) => normalized.toLowerCase().includes(token.toLowerCase()) || token.toLowerCase().includes(normalized.toLowerCase()),
      ),
  );
}

function isPseudoOwner(value?: string) {
  return (
    !value ||
    PSEUDO_OWNERS.has(value) ||
    /^(今天|今晚|明早|明天|明晚|后天|上午|下午|晚上|一起)/.test(value) ||
    isTaskObjectOwner(value)
  );
}

function normalizeOwnerName(value?: string) {
  const owner = value?.trim().replace(/(今天|今晚|明早|明天|明晚|后天|上午|下午|晚上|一起)+$/g, "");
  return isPseudoOwner(owner) ? undefined : owner;
}

function extractOwner(segment: string) {
  const explicitOwner = segment.match(
    /(?:owner\s*(?:是|=|：|:)?|负责人\s*(?:是|=|：|:)?)([A-Za-z][\w-]*|[\u4e00-\u9fa5]{2,4})/i,
  );
  const explicitOwnerName = normalizeOwnerName(explicitOwner?.[1]);
  if (explicitOwnerName) {
    return explicitOwnerName;
  }

  const responsible = segment.match(
    /^([A-Za-z][\w-]*|[\u4e00-\u9fa5]{2,4})(?:\s*\+\s*([A-Za-z][\w-]*|[\u4e00-\u9fa5]{2,4}))?.{0,18}(?:负责|跟进|来做|处理|整理|打通|验收)/,
  );
  if (!responsible) {
    return undefined;
  }
  const first = normalizeOwnerName(responsible[1]);
  const second = normalizeOwnerName(responsible[2]);
  if (first && second) {
    return `${first} + ${second}`;
  }
  return first;
}

function stripTaskPrefix(segment: string, owner?: string) {
  let title = segment;
  if (owner) {
    for (const name of owner.split(/\s*\+\s*/)) {
      title = title.replace(new RegExp(`^${name}\\s*`), "");
    }
  }
  title = title.replace(/^(今天|今晚|明早|明天|明晚|后天|晚上|上午|下午|先|一起)+/g, "");
  title = title.replace(/^(先|一起|把|将)/, "");
  title = title.replace(/^(负责|跟进|来做|处理|整理|打通|完成|验收)\s*/, "");
  return title.trim() || segment;
}

function normalizeTaskTitle(title: string | undefined, fallbackText: string) {
  const cleaned = (title || fallbackText)
    .replace(/^(今天|今晚|明早|明天|明晚|后天|晚上|上午|下午|先|一起)+/g, "")
    .replace(/^(先|一起|把|将)/, "")
    .replace(/^(负责|跟进|来做|处理|整理|打通|完成|验收)\s*/, "")
    .trim();
  return cleaned || fallbackText.trim() || "未命名任务";
}

function sanitizeTask(task: Partial<ProjectTask>, fallbackEvidenceText?: string): Partial<ProjectTask> {
  const ownerName = normalizeOwnerName(task.ownerName);
  const evidenceText = task.evidenceText || fallbackEvidenceText;
  return {
    ...task,
    title: normalizeTaskTitle(task.title, evidenceText || "未命名任务"),
    ownerName,
    evidenceText,
  };
}

function extractTasks(text: string) {
  const segments = splitTaskSegments(text);
  const tasks = segments
    .map((segment) => {
      const owner = extractOwner(segment);
      const due = extractDue(segment);
      const actionable = owner || /(打通|整理|联调|完成|改完|负责|拆|写|做|修|验证|上线|确认)/.test(segment);
      if (!actionable) {
        return undefined;
      }
      return {
        title: normalizeTaskTitle(stripTaskPrefix(segment, owner), segment),
        ownerName: owner,
        due,
        status: "todo" as const,
        evidenceText: segment,
      };
    })
    .filter((task): task is NonNullable<typeof task> => Boolean(task && task.title));
  return tasks;
}

function extractRisks(text: string) {
  if (!/(风险|来不及|延期|卡住|阻塞|不稳定|没定|没人负责|owner\s*还?没|可能)/i.test(text)) {
    return [];
  }

  const severity: "low" | "medium" | "high" = /(严重|高风险|很大|卡死|完全)/.test(text)
    ? "high"
    : /(小风险|低风险|可控)/.test(text)
      ? "low"
      : "medium";
  const mitigation = /卡片回调|回调/.test(text) ? "卡片失败时降级成文本确认" : undefined;
  const description = text
    .replace(/^我觉得/, "")
    .replace(/^能不能先把这个风险记一下[，,]?/, "")
    .trim();
  return [
    {
      description,
      severity,
      status: "open" as const,
      mitigation,
      evidenceText: text,
    },
  ];
}

function extractDecisions(text: string) {
  if (!/(结论|决定|决策|会议纪要|纪要|复盘结论|刚才定了|最终定|拍板)/.test(text)) {
    return [];
  }
  return [
    {
      title: "项目结论",
      content: text.replace(/^刚才结论[:：]?/, "").trim(),
      evidenceText: text,
    },
  ];
}

function defaultMilestones(text: string) {
  if (/项目领航员|自动拆任务|识别风险|沉淀会议结论/.test(text)) {
    return [
      { title: "群聊入口和消息理解", status: "todo" as const, evidenceText: text },
      { title: "项目任务/风险状态沉淀", status: "todo" as const, evidenceText: text },
      { title: "演示脚本和联调验证", status: "todo" as const, evidenceText: text },
    ];
  }
  return [];
}

export function createProjectPatchHeuristically(
  event: NormalizedMessageEvent,
  route: RouterDecision,
  activeProject?: Project,
): ProjectPatchDecision {
  const text = normalizeText(event);
  const grounding = defaultGrounding(event);
  const patch = emptyPatch("none", event);
  patch.projectMatch = {
    projectId: activeProject?.id,
    projectName: activeProject?.name,
    confidence: activeProject ? 0.85 : 0,
  };
  patch.grounding = grounding;

  if (route.primaryDomain === "project") {
    const members = extractMembers(text);
    const name = extractProjectName(text) || activeProject?.name;
    const goal = extractGoal(text);
    patch.action = activeProject && route.intent !== "project_intake" ? "project_update" : "project_create";
    patch.projectDraft = {
      name,
      goal,
      owners: members,
      members,
      milestones: defaultMilestones(text),
    };
    patch.tasks = extractTasks(text);
    patch.missingFields = [name ? "" : "项目名称", goal ? "" : "项目目标"].filter(Boolean);
    patch.requiresConfirmation = true;
    return patch;
  }

  if (route.primaryDomain === "task") {
    patch.action = "task_create";
    patch.tasks = extractTasks(text);
    patch.requiresConfirmation = true;
    patch.missingFields = patch.tasks.length ? [] : ["任务内容"];
    return patch;
  }

  if (route.primaryDomain === "risk") {
    patch.action = "risk_create";
    patch.risks = extractRisks(text);
    patch.requiresConfirmation = true;
    patch.missingFields = patch.risks?.length ? [] : ["风险描述"];
    return patch;
  }

  if (route.primaryDomain === "decision") {
    patch.action = "decision_create";
    patch.decisions = extractDecisions(text);
    patch.tasks = extractTasks(text);
    patch.requiresConfirmation = true;
    patch.missingFields = patch.decisions?.length || patch.tasks?.length ? [] : ["结论内容"];
    return patch;
  }

  return patch;
}

function stringValue(raw: Record<string, unknown>, snake: string, camel: string) {
  const value = raw[snake] || raw[camel];
  return typeof value === "string" ? value : undefined;
}

function normalizeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeToolDecision(
  raw: Record<string, unknown>,
  fallback: ProjectPatchDecision,
): ProjectPatchDecision {
  const action = stringValue(raw, "action", "action") as ProjectPatchAction | undefined;
  const projectMatch = typeof raw.projectMatch === "object" && raw.projectMatch ? raw.projectMatch : raw.project_match;
  const grounding = typeof raw.grounding === "object" && raw.grounding ? (raw.grounding as Record<string, unknown>) : {};
  const messageIds = normalizeArray<string>(grounding.messageIds || grounding.message_ids);
  const evidenceTexts = normalizeArray<string>(grounding.evidenceTexts || grounding.evidence_texts);
  const fallbackEvidenceText = evidenceTexts[0] || fallback.grounding.evidenceTexts[0];

  const actionValue =
      action &&
      ["none", "project_create", "project_update", "task_create", "risk_create", "decision_create", "note_create"].includes(action)
        ? action
        : fallback.action;
  return {
    action: actionValue,
    projectMatch:
      projectMatch && typeof projectMatch === "object"
        ? {
            projectId: stringValue(projectMatch as Record<string, unknown>, "project_id", "projectId") || fallback.projectMatch.projectId,
            projectName:
              stringValue(projectMatch as Record<string, unknown>, "project_name", "projectName") ||
              fallback.projectMatch.projectName,
            confidence:
              typeof (projectMatch as Record<string, unknown>).confidence === "number"
                ? ((projectMatch as Record<string, unknown>).confidence as number)
                : fallback.projectMatch.confidence,
          }
        : fallback.projectMatch,
    projectDraft:
      (typeof raw.projectDraft === "object" && raw.projectDraft
        ? raw.projectDraft
        : typeof raw.project_draft === "object" && raw.project_draft
          ? raw.project_draft
          : fallback.projectDraft) as ProjectPatchDecision["projectDraft"],
    tasks:
      raw.tasks === undefined
        ? fallback.tasks?.map((task) => sanitizeTask(task, fallbackEvidenceText))
        : normalizeArray<Partial<ProjectTask>>(raw.tasks)
            .map((task) => sanitizeTask(task, fallbackEvidenceText))
            .filter((task) => Boolean(task.title)),
    risks: raw.risks === undefined ? fallback.risks : normalizeArray(raw.risks),
    decisions: raw.decisions === undefined ? fallback.decisions : normalizeArray(raw.decisions),
    notes: raw.notes === undefined ? fallback.notes : normalizeArray(raw.notes),
    assistantReply: stringValue(raw, "assistant_reply", "assistantReply") || fallback.assistantReply,
    missingFields:
      raw.missingFields === undefined && raw.missing_fields === undefined
        ? fallback.missingFields
        : normalizeArray<string>(raw.missingFields || raw.missing_fields),
    requiresConfirmation: actionValue !== "none",
    grounding: {
      messageIds: messageIds.length ? messageIds : fallback.grounding.messageIds,
      evidenceTexts: evidenceTexts.length ? evidenceTexts : fallback.grounding.evidenceTexts,
    },
  };
}

export async function createProjectPatchDecision(input: {
  event: NormalizedMessageEvent;
  route: RouterDecision;
  context: ChatContext;
  activeProject?: Project;
  activeProjectSummary?: string;
  useModel?: boolean;
}): Promise<ProjectPatchDecision> {
  const fallback = createProjectPatchHeuristically(input.event, input.route, input.activeProject);
  if (input.useModel === false || process.env.PROJECTPILOT_OFFLINE_TOOL === "1") {
    return fallback;
  }

  try {
    const raw = await callStructuredLlm(
      [
        { role: "system", content: buildProjectToolPrompt() },
        {
          role: "user",
          content: buildProjectToolUserPayload({
            event: input.event,
            route: input.route,
            context: input.context,
            activeProject: input.activeProject,
            activeProjectSummary: input.activeProjectSummary,
          }),
        },
      ],
      "tool",
    );
    return raw ? normalizeToolDecision(raw, fallback) : fallback;
  } catch (error) {
    console.error("Project Tool Agent 失败，使用离线提取:", error);
    return fallback;
  }
}
