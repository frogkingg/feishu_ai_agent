import {
  MeetingExtraction,
  MvpProjectBrief,
  MvpProjectState,
  ProjectPlan,
  ProjectSpec,
  ProjectTaskDraft,
  RiskScanResult,
} from "../schemas";

function valueOrUnknown(value: string | null | undefined) {
  return value || "待确认";
}

function taskLine(task: ProjectTaskDraft, index: number) {
  const owner = task.owner ? `负责人：${task.owner}` : "负责人待确认";
  const due = task.dueDate ? `截止：${task.dueDate}` : "截止待确认";
  return `${index + 1}. [${task.priority}] ${task.title}（${owner}，${due}）`;
}

function artifactText(paths: string[]) {
  return paths.length ? paths.map((path) => `- ${path}`).join("\n") : "- 暂无";
}

export function formatProjectCreateDraft(draftId: string, spec: ProjectSpec, plan: ProjectPlan) {
  const members = spec.members.length
    ? spec.members.map((member) => `${member.name}${member.role ? `/${member.role}` : ""}`).join("、")
    : "待确认";
  const milestones = plan.milestones.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
  const tasks = plan.tasks.slice(0, 8).map(taskLine).join("\n");
  const missing = [...new Set([...spec.unknownFields, ...plan.unknownFields])];

  return [
    "我先生成了项目立项草案，确认前不会写入飞书任务或文档。",
    "",
    `项目：${valueOrUnknown(spec.name)}`,
    `目标：${valueOrUnknown(spec.goal)}`,
    `Deadline：${valueOrUnknown(spec.deadline)}`,
    `负责人：${valueOrUnknown(spec.owner)}`,
    `成员：${members}`,
    "",
    "里程碑：",
    milestones,
    "",
    "前 8 个任务草案：",
    tasks,
    "",
    `待确认字段：${missing.length ? missing.join("、") : "无"}`,
    "",
    `确认后我会创建项目状态和任务池。回复：确认立项 ${draftId}`,
  ].join("\n");
}

export function formatProjectCreated(project: MvpProjectState, warning: string | null) {
  return [
    warning || "项目空间已创建。",
    "",
    `项目：${project.spec.name || project.projectId}`,
    `任务池：${project.tasks.length} 个任务草案已写入`,
    "",
    "Artifact / 链接：",
    artifactText(project.artifactPaths),
    "",
    "下一步可以直接粘贴会议纪要，我会提取 Action Items / 风险 / 决策，并先生成待确认草案。",
  ].join("\n");
}

export function formatMeetingDraft(draftId: string, extraction: MeetingExtraction) {
  const actions = extraction.actionItems.length
    ? extraction.actionItems.map(taskLine).join("\n")
    : "无明确可执行事项";
  const risks = extraction.risks.length
    ? extraction.risks.map((risk, index) => `${index + 1}. [${risk.severity}] ${risk.description}`).join("\n")
    : "暂无";
  const decisions = extraction.decisions.length
    ? extraction.decisions.map((decision, index) => `${index + 1}. ${decision.content}`).join("\n")
    : "暂无";
  const missing = extraction.actionItems
    .flatMap((task) => [task.owner ? "" : `${task.title} 缺负责人`, task.dueDate ? "" : `${task.title} 缺截止时间`])
    .filter(Boolean);

  return [
    "我从会议纪要里提取了草案，确认前不会创建任务。",
    "",
    `会议摘要：${extraction.summary}`,
    "",
    "Action Items：",
    actions,
    "",
    "风险：",
    risks,
    "",
    "决策：",
    decisions,
    "",
    `待确认字段：${missing.length ? missing.slice(0, 8).join("；") : "无"}`,
    "",
    `确认后我会写入任务池并尝试创建飞书任务。回复：确认创建任务 ${draftId}`,
  ].join("\n");
}

export function formatMeetingConfirmed(
  project: MvpProjectState,
  extraction: MeetingExtraction,
  riskScan: RiskScanResult,
  warning: string | null,
) {
  const tasks = extraction.actionItems.length
    ? extraction.actionItems.map((task, index) => `${index + 1}. ${task.title}`).join("\n")
    : "无新增任务";
  const missing = extraction.actionItems
    .flatMap((task) => [task.owner ? "" : `${task.title} 缺负责人`, task.dueDate ? "" : `${task.title} 缺截止时间`])
    .filter(Boolean);

  return [
    warning || "会议任务已写入。",
    "",
    "新增任务：",
    tasks,
    "",
    `待确认字段：${missing.length ? missing.slice(0, 8).join("；") : "无"}`,
    `当前健康状态：${riskScan.health}，进度 ${riskScan.progressPercent}%（${riskScan.doneTasks}/${riskScan.totalTasks} 完成，${riskScan.blockedTasks} 阻塞）`,
    "",
    `项目：${project.spec.name || project.projectId}`,
  ].join("\n");
}

export function formatProjectBrief(project: MvpProjectState, brief: MvpProjectBrief, riskScan: RiskScanResult) {
  const risks = riskScan.risks.length
    ? riskScan.risks.slice(0, 6).map((risk, index) => `${index + 1}. [${risk.severity}] ${risk.description}`).join("\n")
    : "暂无明显结构化风险";
  const nextStep =
    riskScan.health === "Red"
      ? "先补齐 P0/P1 负责人、截止时间，并处理阻塞项。"
      : riskScan.health === "Yellow"
        ? "补齐缺失 owner/dueDate，再推进下一批 P0 任务。"
        : "继续按计划推进，并在会后粘贴纪要沉淀任务。";

  return [
    `项目简报：${brief.name || project.projectId}`,
    "",
    `目标：${valueOrUnknown(brief.goal)}`,
    `Deadline：${valueOrUnknown(brief.deadline)}`,
    `当前进度：${brief.progressPercent}%`,
    `任务：${brief.totalTasks} 个；完成 ${brief.doneTasks} 个；阻塞 ${brief.blockedTasks} 个`,
    `健康状态：${riskScan.health}`,
    "",
    "当前风险：",
    risks,
    "",
    `下一步建议：${nextStep}`,
    "",
    "知识库 / Artifact：",
    artifactText(brief.artifactPaths),
  ].join("\n");
}

export function formatRiskScan(project: MvpProjectState, riskScan: RiskScanResult) {
  const risks = riskScan.risks.length
    ? riskScan.risks.slice(0, 8).map((risk, index) => `${index + 1}. [${risk.severity}] ${risk.description}`).join("\n")
    : "暂无明显结构化风险";
  return [
    `风险扫描：${project.spec.name || project.projectId}`,
    `健康状态：${riskScan.health}，进度 ${riskScan.progressPercent}%`,
    "",
    risks,
    "",
    "建议：优先补齐 P0/P1 的负责人和截止时间，再处理阻塞项。",
  ].join("\n");
}
