import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  DecisionDraft,
  emptyMvpStoreState,
  MeetingExtraction,
  MvpProjectBrief,
  MvpProjectState,
  MvpStoreState,
  PendingDraft,
  PendingDraftType,
  ProjectTaskDraft,
  RiskDraft,
  createMvpId,
  nowIso,
} from "./schemas";

const MVP_RUNTIME_DIR = join(process.cwd(), ".runtime", "mvp");
const STATE_PATH = join(MVP_RUNTIME_DIR, "state.json");

function cloneState(state: MvpStoreState): MvpStoreState {
  return JSON.parse(JSON.stringify(state)) as MvpStoreState;
}

function readStateFile(): MvpStoreState {
  if (!existsSync(STATE_PATH)) {
    return emptyMvpStoreState();
  }

  const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<MvpStoreState>;
  return {
    projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {},
    activeProjectByChatId:
      parsed.activeProjectByChatId && typeof parsed.activeProjectByChatId === "object"
        ? parsed.activeProjectByChatId
        : {},
    pendingDrafts: parsed.pendingDrafts && typeof parsed.pendingDrafts === "object" ? parsed.pendingDrafts : {},
    toolRuns: Array.isArray(parsed.toolRuns) ? parsed.toolRuns : [],
  };
}

function writeStateFile(state: MvpStoreState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tempPath = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(tempPath, STATE_PATH);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup.
    }
    throw error;
  }
}

function mutateState<T>(action: (state: MvpStoreState) => T): T {
  const state = readStateFile();
  const result = action(state);
  writeStateFile(state);
  return result;
}

export function getMvpStatePath() {
  return STATE_PATH;
}

export function loadState(): MvpStoreState {
  return cloneState(readStateFile());
}

export function saveState(state: MvpStoreState) {
  writeStateFile(cloneState(state));
}

export function upsertProject(project: MvpProjectState): MvpProjectState {
  return mutateState((state) => {
    const timestamp = nowIso();
    const existing = state.projects[project.projectId];
    const next: MvpProjectState = {
      ...existing,
      ...project,
      tasks: project.tasks || existing?.tasks || [],
      meetings: project.meetings || existing?.meetings || [],
      risks: project.risks || existing?.risks || [],
      decisions: project.decisions || existing?.decisions || [],
      artifactPaths: [...new Set([...(existing?.artifactPaths || []), ...(project.artifactPaths || [])])],
      createdAt: existing?.createdAt || project.createdAt || timestamp,
      updatedAt: timestamp,
    };
    state.projects[next.projectId] = next;
    state.activeProjectByChatId[next.chatId] = next.projectId;
    return next;
  });
}

export function getActiveProject(chatId: string): MvpProjectState | undefined {
  const state = readStateFile();
  const projectId = state.activeProjectByChatId[chatId];
  return projectId ? state.projects[projectId] : undefined;
}

export function createPendingDraft(
  type: PendingDraftType,
  chatId: string,
  payload: any,
  projectId?: string,
): PendingDraft {
  return mutateState((state) => {
    const draft: PendingDraft = {
      draftId: createMvpId("draft"),
      type,
      chatId,
      projectId,
      payload,
      createdAt: nowIso(),
      status: "pending",
    };
    state.pendingDrafts[draft.draftId] = draft;
    return draft;
  });
}

export function getPendingDraft(draftId: string): PendingDraft | undefined {
  return readStateFile().pendingDrafts[draftId];
}

export function confirmDraft(draftId: string): PendingDraft | undefined {
  return mutateState((state) => {
    const draft = state.pendingDrafts[draftId];
    if (!draft || draft.status !== "pending") {
      return draft;
    }
    draft.status = "confirmed";
    return draft;
  });
}

export function appendTasks(projectId: string, tasks: ProjectTaskDraft[]): MvpProjectState {
  return mutateState((state) => {
    const project = requireProject(state, projectId);
    const seen = new Set(project.tasks.map((task) => task.taskId));
    for (const task of tasks) {
      if (!seen.has(task.taskId)) {
        project.tasks.push(task);
        seen.add(task.taskId);
      }
    }
    project.updatedAt = nowIso();
    return project;
  });
}

export function appendRisks(projectId: string, risks: RiskDraft[]): MvpProjectState {
  return mutateState((state) => {
    const project = requireProject(state, projectId);
    const seen = new Set(project.risks.map((risk) => risk.riskId));
    for (const risk of risks) {
      if (!seen.has(risk.riskId)) {
        project.risks.push(risk);
        seen.add(risk.riskId);
      }
    }
    project.updatedAt = nowIso();
    return project;
  });
}

export function appendDecisions(projectId: string, decisions: DecisionDraft[]): MvpProjectState {
  return mutateState((state) => {
    const project = requireProject(state, projectId);
    const seen = new Set(project.decisions.map((decision) => decision.decisionId));
    for (const decision of decisions) {
      if (!seen.has(decision.decisionId)) {
        project.decisions.push(decision);
        seen.add(decision.decisionId);
      }
    }
    project.updatedAt = nowIso();
    return project;
  });
}

export function appendMeeting(projectId: string, meetingExtraction: MeetingExtraction): MvpProjectState {
  return mutateState((state) => {
    const project = requireProject(state, projectId);
    project.meetings.push(meetingExtraction);
    project.updatedAt = nowIso();
    return project;
  });
}

export function appendToolRun(toolRun: any) {
  mutateState((state) => {
    state.toolRuns.push({
      ...toolRun,
      createdAt: toolRun?.createdAt || nowIso(),
    });
    state.toolRuns = state.toolRuns.slice(-200);
  });
}

export function appendProjectArtifacts(projectId: string, artifactPaths: string[]): MvpProjectState {
  return mutateState((state) => {
    const project = requireProject(state, projectId);
    project.artifactPaths = [...new Set([...project.artifactPaths, ...artifactPaths])];
    if (project.workspace) {
      project.workspace.artifactPaths = [...new Set([...project.workspace.artifactPaths, ...artifactPaths])];
    }
    project.updatedAt = nowIso();
    return project;
  });
}

export function buildProjectBrief(projectId: string): MvpProjectBrief {
  const state = readStateFile();
  const project = requireProject(state, projectId);
  const totalTasks = project.tasks.length;
  const doneTasks = project.tasks.filter((task) => task.status === "Done").length;
  const blockedTasks = project.tasks.filter((task) => task.status === "Blocked").length;
  const progressPercent = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return {
    projectId: project.projectId,
    name: project.spec.name,
    goal: project.spec.goal,
    deadline: project.spec.deadline,
    owner: project.spec.owner,
    totalTasks,
    doneTasks,
    blockedTasks,
    progressPercent,
    openRisks: project.risks.filter((risk) => risk.status !== "Closed").slice(-10),
    recentDecisions: project.decisions.slice(-5),
    artifactPaths: project.artifactPaths,
  };
}

function requireProject(state: MvpStoreState, projectId: string): MvpProjectState {
  const project = state.projects[projectId];
  if (!project) {
    throw new Error(`找不到 MVP 项目: ${projectId}`);
  }
  return project;
}
