import { formatMeetingConfirmed, formatProjectCreated } from "../agents/comms-agent";
import { riskAgent } from "../agents/risk-agent";
import {
  MeetingExtraction,
  MvpHandledResult,
  MvpProjectState,
  ProjectPlan,
  ProjectSpec,
  validateMeetingExtraction,
  validateProjectPlan,
  validateProjectSpec,
  nowIso,
} from "../schemas";
import {
  appendDecisions,
  appendMeeting,
  appendRisks,
  appendTasks,
  confirmDraft,
  getPendingDraft,
  upsertProject,
} from "../store";
import { LarkAdapter, LarkAdapterResult } from "../tools/lark-adapter";

function collectWarnings(...items: Array<string | null | undefined | LarkAdapterResult>) {
  const warnings = items
    .map((item) => (typeof item === "string" || item === null || item === undefined ? item : item.warning))
    .filter(Boolean) as string[];
  return [...new Set(warnings)].join("\n") || null;
}

function payloadAsProjectCreate(payload: unknown): { spec: ProjectSpec; plan: ProjectPlan } {
  const raw = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return {
    spec: validateProjectSpec(raw.spec),
    plan: validateProjectPlan(raw.plan),
  };
}

function buildProjectState(chatId: string, spec: ProjectSpec, plan: ProjectPlan): MvpProjectState {
  const timestamp = nowIso();
  return {
    projectId: spec.projectId,
    chatId,
    spec,
    plan,
    tasks: [],
    meetings: [],
    risks: [],
    decisions: [],
    artifactPaths: [],
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function handleConfirmationWorkflow(draftId: string): Promise<MvpHandledResult> {
  const pending = getPendingDraft(draftId);
  if (!pending) {
    return { handled: true, replyText: `没有找到草案 ${draftId}。` };
  }
  if (pending.status !== "pending") {
    return { handled: true, replyText: `草案 ${draftId} 当前状态是 ${pending.status}，不会重复执行。` };
  }

  if (pending.type === "project_create") {
    const { spec, plan } = payloadAsProjectCreate(pending.payload);
    confirmDraft(draftId);
    const lark = new LarkAdapter();
    const workspace = await lark.createProjectWorkspace(spec, plan);
    const projectDraft = {
      ...buildProjectState(pending.chatId, spec, plan),
      workspace,
      artifactPaths: workspace.artifactPaths,
    };
    upsertProject(projectDraft);
    const projectWithTasks = appendTasks(spec.projectId, plan.tasks);
    const overviewResult = await lark.writeProjectOverview(projectWithTasks);
    const updatedProject = {
      ...projectWithTasks,
      artifactPaths: [...new Set([...projectWithTasks.artifactPaths, ...overviewResult.artifactPaths])],
    };
    return {
      handled: true,
      replyText: formatProjectCreated(updatedProject, collectWarnings(workspace.warning, overviewResult)),
    };
  }

  if (pending.type === "meeting_tasks_confirm") {
    if (!pending.projectId) {
      return { handled: true, replyText: `草案 ${draftId} 缺少 projectId，先不写入。` };
    }
    const extraction: MeetingExtraction = validateMeetingExtraction(pending.payload);
    confirmDraft(draftId);
    appendMeeting(pending.projectId, extraction);
    appendTasks(pending.projectId, extraction.actionItems);
    appendRisks(pending.projectId, extraction.risks);
    const project = appendDecisions(pending.projectId, extraction.decisions);

    const lark = new LarkAdapter();
    const meetingResult = await lark.appendMeetingSummary(pending.projectId, extraction);
    const poolResult = await lark.writeTaskPool(pending.projectId, project.tasks);
    const taskResult = await lark.createFeishuTasks(pending.projectId, extraction.actionItems);
    const riskScan = riskAgent(project);
    return {
      handled: true,
      replyText: formatMeetingConfirmed(project, extraction, riskScan, collectWarnings(meetingResult, poolResult, taskResult)),
    };
  }

  if (pending.type === "plan_confirm") {
    confirmDraft(draftId);
    return { handled: true, replyText: `计划草案 ${draftId} 已确认。后续可以继续粘贴会议纪要或查看项目简报。` };
  }

  return { handled: true, replyText: `草案 ${draftId} 的类型暂不支持。` };
}
