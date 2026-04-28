import { callStructuredLlm } from "../../llm/client";
import {
  DecisionDraft,
  MeetingExtraction,
  MvpProjectState,
  ProjectTaskDraft,
  RiskDraft,
  createMvpId,
  validateMeetingExtraction,
} from "../schemas";

function firstMatch(text: string, pattern: RegExp) {
  return text.match(pattern)?.[1]?.trim() || null;
}

function extractOwner(line: string) {
  return firstMatch(line, /(?:负责人|owner|Owner|由|@)\s*[是为:：]?\s*([\u4e00-\u9fa5A-Za-z0-9_]{2,16})/);
}

function extractDueDate(line: string) {
  return firstMatch(
    line,
    /(?:截止|deadline|DDL|完成时间|在|到)\s*([0-9]{4}[-/.年][0-9]{1,2}(?:[-/.月][0-9]{1,2}日?)?|[0-9]{1,2}月[0-9]{1,2}日|本周[一二三四五六日天]?|下周[一二三四五六日天]?|明天|后天|月底|周[一二三四五六日天])/i,
  );
}

function normalizeTitle(line: string) {
  return line
    .replace(/^[-*\d.、\s]+/, "")
    .replace(/^(Action Items?|待办|任务|结论|会议纪要)[:：]/i, "")
    .trim();
}

export function heuristicMeetingExtraction(text: string, project: MvpProjectState): MeetingExtraction {
  const lines = text
    .split(/\r?\n|。|；|;/)
    .map((line) => line.trim())
    .filter(Boolean);
  const actionItems: ProjectTaskDraft[] = [];
  const risks: RiskDraft[] = [];
  const decisions: DecisionDraft[] = [];
  const openQuestions: string[] = [];

  for (const line of lines) {
    const normalized = normalizeTitle(line);
    if (!normalized) {
      continue;
    }

    if (/(风险|阻塞|卡住|延期|来不及|不确定|依赖)/.test(normalized)) {
      risks.push({
        riskId: createMvpId("risk"),
        title: normalized.slice(0, 32),
        description: normalized,
        severity: /(阻塞|延期|来不及)/.test(normalized) ? "High" : "Medium",
        status: "Open",
        owner: extractOwner(normalized),
        mitigation: null,
        evidence: line,
        relatedTaskId: null,
      });
    }

    if (/(决定|决策|结论|确认|拍板|采用|先按)/.test(normalized)) {
      decisions.push({
        decisionId: createMvpId("decision"),
        title: normalized.slice(0, 32),
        content: normalized,
        owner: extractOwner(normalized),
        madeAt: null,
        impact: null,
        evidence: line,
      });
    }

    if (/[？?]$|^(问题|待确认|open question)/i.test(normalized)) {
      openQuestions.push(normalized);
    }

    const isExplicitAction =
      /(Action Items?|待办|任务|负责|跟进|完成|整理|输出|联调|开发|设计|验证|确认|拉齐|推进)/i.test(normalized) &&
      !/(风险|问题|不确定)$/.test(normalized);
    if (isExplicitAction) {
      actionItems.push({
        taskId: createMvpId("task"),
        title: normalized.slice(0, 80),
        description: normalized,
        owner: extractOwner(normalized),
        dueDate: extractDueDate(normalized),
        priority: /P0|必须|今天|明天|阻塞|关键/.test(normalized) ? "P0" : "P1",
        status: "Not Started",
        moduleName: null,
        milestoneName: null,
        source: "Meeting",
        evidence: line,
        confidence: 0.7,
      });
    }
  }

  const dedupedActions = actionItems.filter(
    (task, index, arr) => arr.findIndex((candidate) => candidate.title === task.title) === index,
  );

  return {
    summary: text.replace(/\s+/g, " ").slice(0, 180) || `${project.spec.name || "当前项目"}会议纪要`,
    actionItems: dedupedActions.slice(0, 12),
    risks: risks.slice(0, 8),
    decisions: decisions.slice(0, 8),
    openQuestions: openQuestions.slice(0, 8),
  };
}

export async function meetingAgent(text: string, project: MvpProjectState): Promise<MeetingExtraction> {
  const fallback = heuristicMeetingExtraction(text, project);
  try {
    const raw = await callStructuredLlm(
      [
        {
          role: "system",
          content: [
            "你是 ProjectPilot 的会议纪要提取 Agent。",
            "你只能输出 JSON object，不能输出 Markdown，不能执行工具。",
            "只提取明确可执行事项。不确定 owner/dueDate 必须填 null。",
            "actionItems 必须使用 ProjectTaskDraft 字段，source 必须是 Meeting。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            project: {
              projectId: project.projectId,
              name: project.spec.name,
              goal: project.spec.goal,
              knownMembers: project.spec.members,
              existingTasks: project.tasks.slice(-20),
            },
            text,
          }),
        },
      ],
      "tool",
    );
    if (!raw) {
      return fallback;
    }
    return validateMeetingExtraction(raw);
  } catch (error) {
    console.warn("MVP meeting-agent 使用 heuristic fallback:", error instanceof Error ? error.message : error);
    return fallback;
  }
}
