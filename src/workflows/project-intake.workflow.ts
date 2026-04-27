import { guardProjectPatch } from "../agent/guard";
import {
  buildCommittedReply,
  buildDecisionConfirmation,
  buildProjectDraftConfirmation,
  buildRiskConfirmation,
  buildTaskConfirmation,
  WorkflowResult,
} from "../agent/responder";
import { createPendingConfirmation } from "../memory/confirmation-store";
import { applyProjectPatch, createProject } from "../memory/project-store";
import { ChatContext, ConfirmationActionType, NormalizedMessageEvent, Project, ProjectPatchDecision, RouterDecision } from "../llm/schemas";
import { createProjectPatchDecision } from "./project-patch";

function confirmationReply(patch: ProjectPatchDecision) {
  if (patch.action === "task_create") {
    return buildTaskConfirmation(patch.tasks || []);
  }
  if (patch.action === "risk_create") {
    return buildRiskConfirmation(patch.risks || []);
  }
  if (patch.action === "decision_create" || patch.action === "note_create") {
    return buildDecisionConfirmation(patch);
  }
  return buildProjectDraftConfirmation(patch);
}

export async function handleProjectPatchWorkflow(input: {
  event: NormalizedMessageEvent;
  route: RouterDecision;
  context: ChatContext;
  activeProject?: Project;
  activeProjectSummary?: string;
  useModel?: boolean;
}): Promise<WorkflowResult> {
  const patch = await createProjectPatchDecision(input);
  const guard = guardProjectPatch(input.route, patch);
  if (!guard.ok) {
    return { status: "failed", reply: guard.reason || "这个动作还不能安全写入项目状态。", patch };
  }

  if (patch.action === "none") {
    return {
      status: "no_action",
      reply: patch.assistantReply || "我看到了。这里更像是讨论内容，暂时不用写入项目状态。",
      patch,
    };
  }

  if (!input.event.chatId || !input.event.senderId) {
    return { status: "failed", reply: "缺少会话或发送者信息，先不写入项目状态。", patch };
  }

  if (!input.activeProject && !["project_create", "project_update"].includes(patch.action)) {
    return {
      status: "failed",
      reply: "我识别到了项目推进信息，但当前群聊还没有项目草案。先告诉我项目名称和目标，我再把任务/风险挂进去。",
      patch,
    };
  }

  createPendingConfirmation({
    chatId: input.event.chatId,
    requesterId: input.event.senderId,
    actionType: patch.action as ConfirmationActionType,
    projectId: input.activeProject?.id || patch.projectMatch.projectId,
    payload: patch,
    evidence: patch.grounding,
  });

  return {
    status: "pending_confirmation",
    reply: patch.assistantReply || confirmationReply(patch),
    project: input.activeProject,
    patch,
  };
}

export function commitProjectPatchFromConfirmation(input: {
  chatId: string;
  confirmationProjectId?: string;
  patch: ProjectPatchDecision;
  activeProject?: Project;
}): WorkflowResult {
  const patch = input.patch;
  let project: Project;

  if (patch.action === "project_create" || (!input.confirmationProjectId && !input.activeProject)) {
    project = createProject(input.chatId, patch.projectDraft, patch.grounding);
    if (patch.tasks?.length || patch.risks?.length || patch.decisions?.length || patch.notes?.length) {
      project = applyProjectPatch(project.id, { ...patch, action: "project_update", projectDraft: undefined });
    }
  } else {
    const projectId = input.confirmationProjectId || input.activeProject?.id || patch.projectMatch.projectId;
    if (!projectId) {
      return { status: "failed", reply: "没有找到要写入的项目，先不记录。", patch };
    }
    project = applyProjectPatch(projectId, patch);
  }

  return {
    status: "committed",
    reply: buildCommittedReply(project, patch),
    project,
    patch,
  };
}

export async function handleProjectIntakeWorkflow(input: {
  event: NormalizedMessageEvent;
  route: RouterDecision;
  context: ChatContext;
  activeProject?: Project;
  activeProjectSummary?: string;
  useModel?: boolean;
}) {
  return handleProjectPatchWorkflow(input);
}
