import { MvpProjectState, ProjectTaskDraft, RiskDraft, RiskScanResult, createMvpId } from "../schemas";

function parseDueDate(value: string | null) {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .replace(/年|\.|\//g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, "")
    .trim();
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function riskFromTask(task: ProjectTaskDraft, title: string, description: string, severity: RiskDraft["severity"]) {
  return {
    riskId: createMvpId("risk"),
    title,
    description,
    severity,
    status: "Open" as const,
    owner: task.owner,
    mitigation: null,
    evidence: task.evidence,
    relatedTaskId: task.taskId,
  };
}

export function riskAgent(project: MvpProjectState): RiskScanResult {
  const risks: RiskDraft[] = [];
  const now = new Date();

  for (const task of project.tasks) {
    if ((task.priority === "P0" || task.priority === "P1") && !task.owner) {
      risks.push(
        riskFromTask(task, "高优任务缺少负责人", `任务「${task.title}」是 ${task.priority}，但还没有负责人。`, "High"),
      );
    }

    if (!task.dueDate) {
      risks.push(riskFromTask(task, "任务缺少截止时间", `任务「${task.title}」还没有 dueDate。`, "Medium"));
    }

    const due = parseDueDate(task.dueDate);
    if (due && due.getTime() < now.getTime() && task.status !== "Done") {
      risks.push(
        riskFromTask(task, "任务已过期未完成", `任务「${task.title}」截止时间 ${task.dueDate} 已过，但状态是 ${task.status}。`, "High"),
      );
    }

    if (task.status === "Blocked") {
      risks.push(riskFromTask(task, "任务处于阻塞状态", `任务「${task.title}」当前状态为 Blocked。`, "High"));
    }
  }

  const totalTasks = project.tasks.length;
  const doneTasks = project.tasks.filter((task) => task.status === "Done").length;
  const blockedTasks = project.tasks.filter((task) => task.status === "Blocked").length;
  const progressPercent = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const highRisks = risks.filter((risk) => risk.severity === "High").length;
  const health = highRisks || blockedTasks ? "Red" : risks.length ? "Yellow" : "Green";

  return {
    health,
    progressPercent,
    totalTasks,
    doneTasks,
    blockedTasks,
    risks,
  };
}
