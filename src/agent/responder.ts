import { Project, ProjectPatchDecision, ProjectRisk, ProjectTask } from "../llm/schemas";

export interface WorkflowResult {
  status: "no_action" | "pending_confirmation" | "committed" | "failed";
  reply: string;
  project?: Project;
  patch?: ProjectPatchDecision;
  reason?: string;
}

function formatList(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- 暂无";
}

export function buildProjectDraftConfirmation(patch: ProjectPatchDecision) {
  const draft = patch.projectDraft || {};
  const owners = [...(draft.owners || []), ...(draft.members || [])]
    .map((member) => `${member.name}${member.role ? `：${member.role}` : ""}`)
    .filter(Boolean);
  const milestones = (draft.milestones || []).map((milestone) => milestone.title).filter((title): title is string => Boolean(title));
  const tasks = (patch.tasks || []).map((task) => `${task.ownerName ? `${task.ownerName}：` : ""}${task.title}`).filter(Boolean);
  const risks = (patch.risks || []).map((risk) => risk.description).filter((description): description is string => Boolean(description));
  const missing = patch.missingFields.length ? patch.missingFields.join("、") : "";

  return [
    "我先按这个项目草案理解：",
    "",
    `项目：${draft.name || patch.projectMatch.projectName || "未命名项目草案"}`,
    draft.goal ? `目标：${draft.goal}` : "",
    "",
    "我提取到：",
    owners.length ? `- 负责人/成员：${owners.join("、")}` : "",
    milestones.length ? `- 关键节点：${milestones.join("；")}` : "",
    tasks.length ? `- 任务：${tasks.join("；")}` : "",
    risks.length ? `- 风险：${risks.join("；")}` : "",
    missing ? `\n还缺：${missing}` : "",
    missing ? `我可以先记成草案，但最好再补一个：${patch.missingFields[0]}。` : "要不要我先记录成项目草案？",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildTaskConfirmation(tasks: Array<Partial<ProjectTask>>) {
  const lines = tasks.map((task, index) => {
    const owner = task.ownerName || "待定";
    const due = task.due ? `，截止 ${task.due}` : "";
    return `${index + 1}. ${owner}：${task.title || "未命名任务"}${due}`;
  });
  return [`我提取到 ${tasks.length} 个 action items：`, "", ...lines, "", "要不要我记录到项目任务池？"].join("\n");
}

export function buildRiskConfirmation(risks: Array<Partial<ProjectRisk>>) {
  const risk = risks[0];
  if (!risk) {
    return "这里可能有项目风险。要不要我记到项目风险里？";
  }

  return [
    `这里有个${risk.severity || "medium"}风险：${risk.description || "项目推进存在不确定性"}。`,
    risk.mitigation ? `建议下一步：${risk.mitigation}` : "建议下一步：先明确 owner、兜底方案和最晚确认时间。",
    "",
    "要不要我记到项目风险里？",
  ].join("\n");
}

export function buildDecisionConfirmation(patch: ProjectPatchDecision) {
  const decisions = patch.decisions || [];
  const notes = patch.notes || [];
  const details = [
    ...decisions.map((decision) => `决策：${decision.title || decision.content || "项目决策"}`),
    ...notes.map((note) => `记录：${note.title || note.content || "项目记录"}`),
  ];
  return ["我可以把刚才的结论沉淀到当前项目：", "", formatList(details), "", "要不要我记录？"].join("\n");
}

export function buildCommittedReply(project: Project, patch: ProjectPatchDecision) {
  const taskCount = patch.tasks?.length || 0;
  const riskCount = patch.risks?.length || 0;
  const decisionCount = patch.decisions?.length || 0;
  const noteCount = patch.notes?.length || 0;
  const additions = [
    patch.action === "project_create" || patch.action === "project_update" ? `项目草案/更新：${project.name}` : "",
    taskCount ? `任务：${taskCount}` : "",
    riskCount ? `风险：${riskCount}` : "",
    decisionCount ? `决策：${decisionCount}` : "",
    noteCount ? `记录：${noteCount}` : "",
  ].filter(Boolean);

  return [
    `已记录到项目：${project.name}。`,
    "",
    "新增：",
    formatList(additions),
    "",
    "后续你们可以直接说“这个风险关掉”“把 owner 改成 Henry”“明早联调完成了”，我会关联到当前项目。",
  ].join("\n");
}
