export type TaskPriority = "P0" | "P1" | "P2";
export type TaskStatus = "Not Started" | "In Progress" | "Blocked" | "Done";
export type TaskSource = "Plan" | "Meeting" | "Chat";
export type DraftStatus = "pending" | "confirmed" | "rejected";
export type PendingDraftType = "project_create" | "plan_confirm" | "meeting_tasks_confirm";
export type HealthStatus = "Green" | "Yellow" | "Red";
export type LarkWriteMode = "mock" | "cli" | "hybrid";

export interface ProjectSpec {
  projectId: string;
  name: string | null;
  goal: string | null;
  deadline: string | null;
  owner: string | null;
  members: Array<{ name: string; role: string | null }>;
  deliverables: string[];
  constraints: string[];
  unknownFields: string[];
}

export interface ProjectWorkspace {
  projectId: string;
  mode: LarkWriteMode;
  artifactPaths: string[];
  larkUrl: string | null;
  warning: string | null;
  createdAt: string;
}

export interface Milestone {
  milestoneId: string;
  name: string;
  description: string | null;
  owner: string | null;
  dueDate: string | null;
  status: TaskStatus;
}

export interface Module {
  moduleId: string;
  name: string;
  description: string | null;
  owner: string | null;
  milestoneName: string | null;
}

export interface ProjectTaskDraft {
  taskId: string;
  title: string;
  description: string | null;
  owner: string | null;
  dueDate: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  moduleName: string | null;
  milestoneName: string | null;
  source: TaskSource;
  evidence: string;
  confidence: number;
}

export interface ProjectPlan {
  projectId: string;
  summary: string;
  milestones: Milestone[];
  modules: Module[];
  tasks: ProjectTaskDraft[];
  assumptions: string[];
  unknownFields: string[];
}

export interface RiskDraft {
  riskId: string;
  title: string;
  description: string;
  severity: "Low" | "Medium" | "High";
  status: "Open" | "Mitigating" | "Closed";
  owner: string | null;
  mitigation: string | null;
  evidence: string;
  relatedTaskId: string | null;
}

export interface DecisionDraft {
  decisionId: string;
  title: string;
  content: string;
  owner: string | null;
  madeAt: string | null;
  impact: string | null;
  evidence: string;
}

export interface MeetingExtraction {
  summary: string;
  actionItems: ProjectTaskDraft[];
  risks: RiskDraft[];
  decisions: DecisionDraft[];
  openQuestions: string[];
}

export interface PendingDraft {
  draftId: string;
  type: PendingDraftType;
  chatId: string;
  projectId?: string;
  payload: any;
  createdAt: string;
  status: DraftStatus;
}

export interface MvpProjectState {
  projectId: string;
  chatId: string;
  spec: ProjectSpec;
  workspace?: ProjectWorkspace;
  plan?: ProjectPlan;
  tasks: ProjectTaskDraft[];
  meetings: MeetingExtraction[];
  risks: RiskDraft[];
  decisions: DecisionDraft[];
  artifactPaths: string[];
  status: "draft" | "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface MvpHandledResult {
  handled: boolean;
  replyText?: string;
}

export interface MvpStoreState {
  projects: Record<string, MvpProjectState>;
  activeProjectByChatId: Record<string, string>;
  pendingDrafts: Record<string, PendingDraft>;
  toolRuns: any[];
}

export interface MvpProjectBrief {
  projectId: string;
  name: string | null;
  goal: string | null;
  deadline: string | null;
  owner: string | null;
  totalTasks: number;
  doneTasks: number;
  blockedTasks: number;
  progressPercent: number;
  openRisks: RiskDraft[];
  recentDecisions: DecisionDraft[];
  artifactPaths: string[];
}

export interface RiskScanResult {
  health: HealthStatus;
  progressPercent: number;
  totalTasks: number;
  doneTasks: number;
  blockedTasks: number;
  risks: RiskDraft[];
}

const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2"];
const TASK_STATUSES: TaskStatus[] = ["Not Started", "In Progress", "Blocked", "Done"];
const TASK_SOURCES: TaskSource[] = ["Plan", "Meeting", "Chat"];
const RISK_SEVERITIES: RiskDraft["severity"][] = ["Low", "Medium", "High"];
const RISK_STATUSES: RiskDraft["status"][] = ["Open", "Mitigating", "Closed"];

export function createMvpId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} 必须是 JSON object`);
  }
  return value;
}

function stringOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} 必须是 string 或 null`);
  }
  return value.trim() || null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空 string`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是 string[]`);
  }
  return value
    .map((item) => {
      if (typeof item !== "string") {
        throw new Error(`${label} 必须只包含 string`);
      }
      return item.trim();
    })
    .filter(Boolean);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} 不在允许值内: ${allowed.join(", ")}`);
  }
  return value as T;
}

function confidenceValue(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} 必须是数字`);
  }
  return Math.max(0, Math.min(1, parsed));
}

export function unwrapPayload(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return raw;
}

export function validateProjectSpec(value: unknown): ProjectSpec {
  const raw = unwrapPayload(requireRecord(value, "ProjectSpec"), ["projectSpec", "project_spec", "spec"]);
  const membersRaw = raw.members;
  if (!Array.isArray(membersRaw)) {
    throw new Error("ProjectSpec.members 必须是数组");
  }
  const members = membersRaw.map((member, index) => {
    const item = requireRecord(member, `ProjectSpec.members[${index}]`);
    return {
      name: requiredString(item.name, `ProjectSpec.members[${index}].name`),
      role: stringOrNull(item.role, `ProjectSpec.members[${index}].role`),
    };
  });

  return {
    projectId: requiredString(raw.projectId || raw.project_id, "ProjectSpec.projectId"),
    name: stringOrNull(raw.name, "ProjectSpec.name"),
    goal: stringOrNull(raw.goal, "ProjectSpec.goal"),
    deadline: stringOrNull(raw.deadline, "ProjectSpec.deadline"),
    owner: stringOrNull(raw.owner, "ProjectSpec.owner"),
    members,
    deliverables: stringArray(raw.deliverables, "ProjectSpec.deliverables"),
    constraints: stringArray(raw.constraints, "ProjectSpec.constraints"),
    unknownFields: stringArray(raw.unknownFields || raw.unknown_fields, "ProjectSpec.unknownFields"),
  };
}

export function validateMilestone(value: unknown, index = 0): Milestone {
  const raw = requireRecord(value, `Milestone[${index}]`);
  return {
    milestoneId: requiredString(raw.milestoneId || raw.milestone_id, `Milestone[${index}].milestoneId`),
    name: requiredString(raw.name, `Milestone[${index}].name`),
    description: stringOrNull(raw.description, `Milestone[${index}].description`),
    owner: stringOrNull(raw.owner, `Milestone[${index}].owner`),
    dueDate: stringOrNull(raw.dueDate || raw.due_date, `Milestone[${index}].dueDate`),
    status: enumValue(raw.status, TASK_STATUSES, `Milestone[${index}].status`),
  };
}

export function validateModule(value: unknown, index = 0): Module {
  const raw = requireRecord(value, `Module[${index}]`);
  return {
    moduleId: requiredString(raw.moduleId || raw.module_id, `Module[${index}].moduleId`),
    name: requiredString(raw.name, `Module[${index}].name`),
    description: stringOrNull(raw.description, `Module[${index}].description`),
    owner: stringOrNull(raw.owner, `Module[${index}].owner`),
    milestoneName: stringOrNull(raw.milestoneName || raw.milestone_name, `Module[${index}].milestoneName`),
  };
}

export function validateTaskDraft(value: unknown, index = 0): ProjectTaskDraft {
  const raw = requireRecord(value, `ProjectTaskDraft[${index}]`);
  return {
    taskId: requiredString(raw.taskId || raw.task_id, `ProjectTaskDraft[${index}].taskId`),
    title: requiredString(raw.title, `ProjectTaskDraft[${index}].title`),
    description: stringOrNull(raw.description, `ProjectTaskDraft[${index}].description`),
    owner: stringOrNull(raw.owner, `ProjectTaskDraft[${index}].owner`),
    dueDate: stringOrNull(raw.dueDate || raw.due_date, `ProjectTaskDraft[${index}].dueDate`),
    priority: enumValue(raw.priority, TASK_PRIORITIES, `ProjectTaskDraft[${index}].priority`),
    status: enumValue(raw.status, TASK_STATUSES, `ProjectTaskDraft[${index}].status`),
    moduleName: stringOrNull(raw.moduleName || raw.module_name, `ProjectTaskDraft[${index}].moduleName`),
    milestoneName: stringOrNull(raw.milestoneName || raw.milestone_name, `ProjectTaskDraft[${index}].milestoneName`),
    source: enumValue(raw.source, TASK_SOURCES, `ProjectTaskDraft[${index}].source`),
    evidence: requiredString(raw.evidence, `ProjectTaskDraft[${index}].evidence`),
    confidence: confidenceValue(raw.confidence, `ProjectTaskDraft[${index}].confidence`),
  };
}

export function validateProjectPlan(value: unknown): ProjectPlan {
  const raw = unwrapPayload(requireRecord(value, "ProjectPlan"), ["projectPlan", "project_plan", "plan"]);
  const milestones = Array.isArray(raw.milestones)
    ? raw.milestones.map((item, index) => validateMilestone(item, index))
    : [];
  const modules = Array.isArray(raw.modules) ? raw.modules.map((item, index) => validateModule(item, index)) : [];
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.map((item, index) => validateTaskDraft(item, index)) : [];
  if (milestones.length < 4 || milestones.length > 6) {
    throw new Error("ProjectPlan.milestones 必须有 4-6 个");
  }
  if (tasks.length < 8 || tasks.length > 15) {
    throw new Error("ProjectPlan.tasks 必须有 8-15 个");
  }
  return {
    projectId: requiredString(raw.projectId || raw.project_id, "ProjectPlan.projectId"),
    summary: requiredString(raw.summary, "ProjectPlan.summary"),
    milestones,
    modules,
    tasks,
    assumptions: stringArray(raw.assumptions, "ProjectPlan.assumptions"),
    unknownFields: stringArray(raw.unknownFields || raw.unknown_fields, "ProjectPlan.unknownFields"),
  };
}

export function validateRiskDraft(value: unknown, index = 0): RiskDraft {
  const raw = requireRecord(value, `RiskDraft[${index}]`);
  return {
    riskId: requiredString(raw.riskId || raw.risk_id, `RiskDraft[${index}].riskId`),
    title: requiredString(raw.title, `RiskDraft[${index}].title`),
    description: requiredString(raw.description, `RiskDraft[${index}].description`),
    severity: enumValue(raw.severity, RISK_SEVERITIES, `RiskDraft[${index}].severity`),
    status: enumValue(raw.status, RISK_STATUSES, `RiskDraft[${index}].status`),
    owner: stringOrNull(raw.owner, `RiskDraft[${index}].owner`),
    mitigation: stringOrNull(raw.mitigation, `RiskDraft[${index}].mitigation`),
    evidence: requiredString(raw.evidence, `RiskDraft[${index}].evidence`),
    relatedTaskId: stringOrNull(raw.relatedTaskId || raw.related_task_id, `RiskDraft[${index}].relatedTaskId`),
  };
}

export function validateDecisionDraft(value: unknown, index = 0): DecisionDraft {
  const raw = requireRecord(value, `DecisionDraft[${index}]`);
  return {
    decisionId: requiredString(raw.decisionId || raw.decision_id, `DecisionDraft[${index}].decisionId`),
    title: requiredString(raw.title, `DecisionDraft[${index}].title`),
    content: requiredString(raw.content, `DecisionDraft[${index}].content`),
    owner: stringOrNull(raw.owner, `DecisionDraft[${index}].owner`),
    madeAt: stringOrNull(raw.madeAt || raw.made_at, `DecisionDraft[${index}].madeAt`),
    impact: stringOrNull(raw.impact, `DecisionDraft[${index}].impact`),
    evidence: requiredString(raw.evidence, `DecisionDraft[${index}].evidence`),
  };
}

export function validateMeetingExtraction(value: unknown): MeetingExtraction {
  const raw = unwrapPayload(requireRecord(value, "MeetingExtraction"), ["meetingExtraction", "meeting_extraction", "extraction"]);
  const rawActionItems = raw.actionItems || raw.action_items;
  return {
    summary: requiredString(raw.summary, "MeetingExtraction.summary"),
    actionItems: Array.isArray(rawActionItems)
      ? rawActionItems.map((item: unknown, index: number) => validateTaskDraft(item, index))
      : [],
    risks: Array.isArray(raw.risks) ? raw.risks.map((item, index) => validateRiskDraft(item, index)) : [],
    decisions: Array.isArray(raw.decisions)
      ? raw.decisions.map((item, index) => validateDecisionDraft(item, index))
      : [],
    openQuestions: stringArray(raw.openQuestions || raw.open_questions, "MeetingExtraction.openQuestions"),
  };
}

export function emptyMvpStoreState(): MvpStoreState {
  return {
    projects: {},
    activeProjectByChatId: {},
    pendingDrafts: {},
    toolRuns: [],
  };
}
