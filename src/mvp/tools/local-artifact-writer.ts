import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { MeetingExtraction, MvpProjectState, ProjectPlan, ProjectSpec, ProjectTaskDraft, nowIso } from "../schemas";

const ARTIFACT_DIR = join(process.cwd(), ".runtime", "mvp", "artifacts");

function ensureDir() {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function safeName(value: string | null | undefined, fallback: string) {
  return (value || fallback).replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 60);
}

function writeArtifact(filename: string, content: string) {
  ensureDir();
  const path = join(ARTIFACT_DIR, filename);
  writeFileSync(path, content, "utf8");
  return path;
}

function appendArtifact(filename: string, content: string) {
  ensureDir();
  const path = join(ARTIFACT_DIR, filename);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, `${existing}${existing ? "\n\n" : ""}${content}`, "utf8");
  return path;
}

function formatTasks(tasks: ProjectTaskDraft[]) {
  if (!tasks.length) {
    return "暂无任务。";
  }
  return tasks
    .map(
      (task, index) =>
        `${index + 1}. [${task.priority}] ${task.title}\n   - owner: ${task.owner || "待确认"}\n   - dueDate: ${
          task.dueDate || "待确认"
        }\n   - status: ${task.status}\n   - source: ${task.source}\n   - evidence: ${task.evidence}`,
    )
    .join("\n");
}

export function writeProjectCreateArtifacts(spec: ProjectSpec, plan: ProjectPlan) {
  const base = `${safeName(spec.name, spec.projectId)}_${spec.projectId}`;
  const overviewPath = writeArtifact(
    `${base}_overview.md`,
    [
      `# ${spec.name || "未命名项目"}`,
      "",
      `- projectId: ${spec.projectId}`,
      `- goal: ${spec.goal || "待确认"}`,
      `- deadline: ${spec.deadline || "待确认"}`,
      `- owner: ${spec.owner || "待确认"}`,
      `- createdAt: ${nowIso()}`,
      "",
      "## Members",
      spec.members.length ? spec.members.map((member) => `- ${member.name}: ${member.role || "待确认"}`).join("\n") : "- 待确认",
      "",
      "## Milestones",
      plan.milestones.map((item) => `- ${item.name}: ${item.dueDate || "待确认"}`).join("\n"),
      "",
      "## Unknown Fields",
      spec.unknownFields.length ? spec.unknownFields.map((item) => `- ${item}`).join("\n") : "- 无",
    ].join("\n"),
  );
  const taskPoolPath = writeArtifact(`${base}_task_pool.md`, `# Task Pool\n\n${formatTasks(plan.tasks)}`);
  return [overviewPath, taskPoolPath];
}

export function writeProjectOverview(project: MvpProjectState) {
  const base = `${safeName(project.spec.name, project.projectId)}_${project.projectId}`;
  return writeArtifact(
    `${base}_overview.md`,
    [
      `# ${project.spec.name || "未命名项目"}`,
      "",
      `- projectId: ${project.projectId}`,
      `- status: ${project.status}`,
      `- goal: ${project.spec.goal || "待确认"}`,
      `- deadline: ${project.spec.deadline || "待确认"}`,
      `- owner: ${project.spec.owner || "待确认"}`,
      `- updatedAt: ${project.updatedAt}`,
      "",
      "## Progress",
      `- tasks: ${project.tasks.length}`,
      `- risks: ${project.risks.length}`,
      `- decisions: ${project.decisions.length}`,
      `- meetings: ${project.meetings.length}`,
    ].join("\n"),
  );
}

export function writeTaskPool(projectId: string, tasks: ProjectTaskDraft[]) {
  return writeArtifact(`${projectId}_task_pool.md`, `# Task Pool\n\n${formatTasks(tasks)}`);
}

export function appendMeetingSummary(projectId: string, extraction: MeetingExtraction) {
  return appendArtifact(
    `${projectId}_meetings.md`,
    [
      `# Meeting ${nowIso()}`,
      "",
      `## Summary\n${extraction.summary}`,
      "",
      "## Action Items",
      formatTasks(extraction.actionItems),
      "",
      "## Risks",
      extraction.risks.length
        ? extraction.risks.map((risk) => `- [${risk.severity}] ${risk.description}`).join("\n")
        : "- 暂无",
      "",
      "## Decisions",
      extraction.decisions.length ? extraction.decisions.map((decision) => `- ${decision.content}`).join("\n") : "- 暂无",
    ].join("\n"),
  );
}

export function writeMockMessage(chatId: string, text: string) {
  return appendArtifact(`${chatId}_messages.md`, `## Message ${nowIso()}\n\n${text}`);
}
