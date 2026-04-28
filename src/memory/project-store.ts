import { CONFIRMATION_STORE_PATH, PROJECT_STORE_PATH, PROJECT_SUMMARY_MAX_CHARS } from "../config/constants";
import {
  GroundingEvidence,
  Milestone,
  Project,
  ProjectDecision,
  ProjectMember,
  ProjectNote,
  ProjectPatchDecision,
  ProjectRisk,
  ProjectStore,
  ProjectTask,
} from "../llm/schemas";
import { readJsonFile, withFileLock, writeJsonFileAtomic } from "./json-file";

const PROJECT_STORE_LOCK_PATH = `${PROJECT_STORE_PATH}.lock`;

export function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function hasGroundingEvidence(evidence?: GroundingEvidence) {
  return Boolean(evidence && (evidence.messageIds.length > 0 || evidence.evidenceTexts.length > 0));
}

function assertGrounded(evidence: GroundingEvidence) {
  if (!hasGroundingEvidence(evidence)) {
    throw new Error("项目写入缺少 grounding evidence");
  }
}

function emptyStore(): ProjectStore {
  return { version: 1, projects: [] };
}

export function loadProjectStore(): ProjectStore {
  const parsed = readJsonFile<Partial<ProjectStore>>(PROJECT_STORE_PATH, emptyStore, "项目状态文件");
  return {
    version: 1,
    projects: Array.isArray(parsed.projects) ? (parsed.projects as Project[]) : [],
  };
}

export function saveProjectStore(store: ProjectStore): void {
  writeJsonFileAtomic(PROJECT_STORE_PATH, { version: 1, projects: store.projects });
}

export function listProjectsByChat(chatId: string): Project[] {
  return loadProjectStore().projects.filter((project) => project.chatId === chatId);
}

export function getActiveProjectForChat(chatId: string): Project | undefined {
  const projects = listProjectsByChat(chatId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return projects.find((project) => project.status === "active") || projects.find((project) => project.status === "draft");
}

function uniqueMembers(members: ProjectMember[] = []) {
  const seen = new Set<string>();
  return members.filter((member) => {
    const key = member.openId || member.name;
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function firstEvidence(evidence: GroundingEvidence) {
  return evidence.evidenceTexts[0];
}

function firstMessageId(evidence: GroundingEvidence) {
  return evidence.messageIds[0];
}

export function createProject(
  chatId: string,
  draft: ProjectPatchDecision["projectDraft"] = {},
  evidence: GroundingEvidence,
): Project {
  assertGrounded(evidence);
  return withFileLock(PROJECT_STORE_LOCK_PATH, () => {
    const store = loadProjectStore();
    const timestamp = nowIso();
    const project: Project = {
      id: createId("proj"),
      chatId,
      name: draft.name?.trim() || "未命名项目草案",
      status: "draft",
      goal: draft.goal,
      background: draft.background,
      owners: uniqueMembers(draft.owners || []),
      members: uniqueMembers([...(draft.members || []), ...(draft.owners || [])]),
      milestones: normalizeMilestones(draft.milestones || [], evidence, timestamp),
      tasks: [],
      risks: [],
      decisions: [],
      notes: [],
      sourceMessageIds: evidence.messageIds,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    store.projects.push(project);
    saveProjectStore(store);
    return project;
  });
}

function normalizeMilestones(
  milestones: Array<Partial<Milestone>>,
  evidence: GroundingEvidence,
  timestamp = nowIso(),
): Milestone[] {
  return milestones
    .filter((milestone) => milestone.title?.trim())
    .map((milestone) => ({
      id: milestone.id || createId("mile"),
      title: milestone.title!.trim(),
      due: milestone.due,
      status: milestone.status || "todo",
      ownerName: milestone.ownerName,
      evidenceText: milestone.evidenceText || firstEvidence(evidence),
      sourceMessageId: milestone.sourceMessageId || firstMessageId(evidence),
      createdAt: milestone.createdAt || timestamp,
      updatedAt: milestone.updatedAt || timestamp,
    }));
}

function normalizeTasks(
  tasks: Array<Partial<ProjectTask>>,
  evidence: GroundingEvidence,
  timestamp = nowIso(),
): ProjectTask[] {
  return tasks
    .filter((task) => task.title?.trim() && (task.evidenceText || firstEvidence(evidence) || task.sourceMessageId || firstMessageId(evidence)))
    .map((task) => ({
      id: task.id || createId("task"),
      title: task.title!.trim(),
      ownerName: task.ownerName,
      ownerOpenId: task.ownerOpenId,
      due: task.due,
      priority: task.priority,
      status: task.status || "todo",
      evidenceText: task.evidenceText || firstEvidence(evidence),
      sourceMessageId: task.sourceMessageId || firstMessageId(evidence),
      createdAt: task.createdAt || timestamp,
      updatedAt: task.updatedAt || timestamp,
    }));
}

function normalizeRisks(
  risks: Array<Partial<ProjectRisk>>,
  evidence: GroundingEvidence,
  timestamp = nowIso(),
): ProjectRisk[] {
  return risks
    .filter((risk) => risk.description?.trim() && (risk.evidenceText || firstEvidence(evidence) || risk.sourceMessageId || firstMessageId(evidence)))
    .map((risk) => ({
      id: risk.id || createId("risk"),
      description: risk.description!.trim(),
      severity: risk.severity || "medium",
      status: risk.status || "open",
      ownerName: risk.ownerName,
      mitigation: risk.mitigation,
      evidenceText: risk.evidenceText || firstEvidence(evidence),
      sourceMessageId: risk.sourceMessageId || firstMessageId(evidence),
      createdAt: risk.createdAt || timestamp,
      updatedAt: risk.updatedAt || timestamp,
    }));
}

function normalizeDecisions(
  decisions: Array<Partial<ProjectDecision>>,
  evidence: GroundingEvidence,
  timestamp = nowIso(),
): ProjectDecision[] {
  return decisions
    .filter((decision) => (decision.title?.trim() || decision.content?.trim()) && (decision.evidenceText || firstEvidence(evidence) || decision.sourceMessageId || firstMessageId(evidence)))
    .map((decision) => ({
      id: decision.id || createId("decision"),
      title: decision.title?.trim() || "项目决策",
      content: decision.content?.trim() || decision.title!.trim(),
      impact: decision.impact,
      evidenceText: decision.evidenceText || firstEvidence(evidence),
      sourceMessageId: decision.sourceMessageId || firstMessageId(evidence),
      createdAt: decision.createdAt || timestamp,
    }));
}

function normalizeNotes(
  notes: Array<Partial<ProjectNote>>,
  evidence: GroundingEvidence,
  timestamp = nowIso(),
): ProjectNote[] {
  return notes
    .filter((note) => (note.title?.trim() || note.content?.trim()) && (note.evidenceText || firstEvidence(evidence) || note.sourceMessageId || firstMessageId(evidence)))
    .map((note) => ({
      id: note.id || createId("note"),
      type: note.type || "general_note",
      title: note.title?.trim() || "项目记录",
      content: note.content?.trim() || note.title!.trim(),
      evidenceText: note.evidenceText || firstEvidence(evidence),
      sourceMessageId: note.sourceMessageId || firstMessageId(evidence),
      createdAt: note.createdAt || timestamp,
    }));
}

export function applyProjectPatch(projectId: string, patch: ProjectPatchDecision): Project {
  assertGrounded(patch.grounding);
  return withFileLock(PROJECT_STORE_LOCK_PATH, () => {
    const store = loadProjectStore();
    const project = store.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`找不到项目: ${projectId}`);
    }

    const timestamp = nowIso();
    if (patch.projectDraft?.name?.trim()) {
      project.name = patch.projectDraft.name.trim();
    }
    if (patch.projectDraft?.goal?.trim()) {
      project.goal = patch.projectDraft.goal.trim();
    }
    if (patch.projectDraft?.background?.trim()) {
      project.background = patch.projectDraft.background.trim();
    }
    if (patch.projectDraft?.owners?.length) {
      project.owners = uniqueMembers([...project.owners, ...patch.projectDraft.owners]);
    }
    if (patch.projectDraft?.members?.length || patch.projectDraft?.owners?.length) {
      project.members = uniqueMembers([
        ...project.members,
        ...(patch.projectDraft.members || []),
        ...(patch.projectDraft.owners || []),
      ]);
    }

    project.milestones.push(...normalizeMilestones(patch.projectDraft?.milestones || [], patch.grounding, timestamp));
    project.tasks.push(...normalizeTasks(patch.tasks || [], patch.grounding, timestamp));
    project.risks.push(...normalizeRisks(patch.risks || [], patch.grounding, timestamp));
    project.decisions.push(...normalizeDecisions(patch.decisions || [], patch.grounding, timestamp));
    project.notes.push(...normalizeNotes(patch.notes || [], patch.grounding, timestamp));
    project.sourceMessageIds = [...new Set([...project.sourceMessageIds, ...patch.grounding.messageIds])];
    project.updatedAt = timestamp;

    saveProjectStore(store);
    return project;
  });
}

export function summarizeProjectForPrompt(project: Project | undefined): string {
  if (!project) {
    return "当前群聊还没有项目状态。";
  }

  const parts = [
    `项目：${project.name}（${project.status}）`,
    project.goal ? `目标：${project.goal}` : "",
    project.owners.length ? `负责人：${project.owners.map((owner) => `${owner.name}${owner.role ? `/${owner.role}` : ""}`).join("、")}` : "",
    project.members.length ? `成员：${project.members.map((member) => `${member.name}${member.role ? `/${member.role}` : ""}`).join("、")}` : "",
    project.milestones.length ? `节点：${project.milestones.slice(-5).map((milestone) => milestone.title).join("；")}` : "",
    project.tasks.length ? `任务：${project.tasks.slice(-6).map((task) => `${task.ownerName ? `${task.ownerName}:` : ""}${task.title}${task.due ? `(${task.due})` : ""}`).join("；")}` : "",
    project.risks.length ? `风险：${project.risks.slice(-5).map((risk) => `${risk.severity}:${risk.description}`).join("；")}` : "",
    project.decisions.length ? `决策：${project.decisions.slice(-4).map((decision) => decision.title).join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return parts.length > PROJECT_SUMMARY_MAX_CHARS ? `${parts.slice(0, PROJECT_SUMMARY_MAX_CHARS - 1)}…` : parts;
}

export function getProjectStorePath() {
  return PROJECT_STORE_PATH;
}

export function getConfirmationStorePathForDebug() {
  return CONFIRMATION_STORE_PATH;
}
