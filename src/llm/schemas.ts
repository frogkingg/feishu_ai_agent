export type SafetyLabel = "normal" | "joke" | "insult" | "hypothetical" | "ambiguous";

export type ResponseMode = "silent" | "chat" | "suggest" | "confirm_action" | "execute_action";

export type PrimaryDomain =
  | "project"
  | "task"
  | "risk"
  | "decision"
  | "calendar"
  | "smalltalk"
  | "ignore";

export type RouterIntent =
  | "project_intake"
  | "project_update"
  | "task_extract"
  | "risk_check"
  | "decision_capture"
  | "calendar_create"
  | "calendar_update"
  | "smalltalk"
  | "ignore";

export type TopicAction = "none" | "create_topic" | "update_topic" | "close_topic";

export interface RouterDecision {
  responseMode: ResponseMode;
  primaryDomain: PrimaryDomain;
  intent: RouterIntent;
  topicAction: TopicAction;
  safetyLabel: SafetyLabel;
  confidence: number;
  reason: string;
}

export interface GroundingEvidence {
  messageIds: string[];
  evidenceTexts: string[];
}

export type ProjectStatus = "draft" | "active" | "paused" | "completed";

export interface ProjectStore {
  version: 1;
  projects: Project[];
}

export interface Project {
  id: string;
  chatId: string;
  name: string;
  status: ProjectStatus;
  goal?: string;
  background?: string;
  owners: ProjectMember[];
  members: ProjectMember[];
  milestones: Milestone[];
  tasks: ProjectTask[];
  risks: ProjectRisk[];
  decisions: ProjectDecision[];
  notes: ProjectNote[];
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  name: string;
  openId?: string;
  role?: string;
  evidenceText?: string;
}

export interface Milestone {
  id: string;
  title: string;
  due?: string;
  status: "todo" | "doing" | "done" | "blocked";
  ownerName?: string;
  evidenceText?: string;
  sourceMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  ownerName?: string;
  ownerOpenId?: string;
  due?: string;
  priority?: "low" | "medium" | "high";
  status: "todo" | "doing" | "done" | "blocked";
  evidenceText?: string;
  sourceMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRisk {
  id: string;
  description: string;
  severity: "low" | "medium" | "high";
  status: "open" | "mitigating" | "closed";
  ownerName?: string;
  mitigation?: string;
  evidenceText?: string;
  sourceMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDecision {
  id: string;
  title: string;
  content: string;
  impact?: string;
  evidenceText?: string;
  sourceMessageId?: string;
  createdAt: string;
}

export interface ProjectNote {
  id: string;
  type: "meeting_summary" | "general_note" | "doc_draft";
  title: string;
  content: string;
  evidenceText?: string;
  sourceMessageId?: string;
  createdAt: string;
}

export type ConfirmationActionType =
  | "project_create"
  | "project_update"
  | "task_create"
  | "risk_create"
  | "decision_create"
  | "note_create"
  | "calendar_create"
  | "calendar_update";

export interface PendingConfirmation {
  id: string;
  chatId: string;
  requesterId: string;
  actionType: ConfirmationActionType;
  projectId?: string;
  payload: unknown;
  evidence: GroundingEvidence;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
}

export type ProjectPatchAction =
  | "none"
  | "project_create"
  | "project_update"
  | "task_create"
  | "risk_create"
  | "decision_create"
  | "note_create";

export interface ProjectPatchDecision {
  action: ProjectPatchAction;
  projectMatch: {
    projectId?: string;
    projectName?: string;
    confidence: number;
  };
  projectDraft?: {
    name?: string;
    goal?: string;
    background?: string;
    owners?: ProjectMember[];
    members?: ProjectMember[];
    milestones?: Array<Partial<Milestone>>;
  };
  tasks?: Array<Partial<ProjectTask>>;
  risks?: Array<Partial<ProjectRisk>>;
  decisions?: Array<Partial<ProjectDecision>>;
  notes?: Array<Partial<ProjectNote>>;
  assistantReply: string;
  missingFields: string[];
  requiresConfirmation: boolean;
  grounding: GroundingEvidence;
}

export interface NormalizedMessageEvent {
  type?: string;
  messageId?: string;
  chatId?: string;
  chatType?: string;
  senderId?: string;
  senderName?: string;
  senderType?: string;
  messageType?: string;
  mentions?: Array<{ id?: string; name?: string }>;
  createTime?: number;
  text: string;
}

export interface ChatContextMessage {
  messageId?: string;
  senderId?: string;
  senderName?: string;
  text: string;
  mentions?: Array<{ id?: string; name?: string }>;
  createTime: number;
}

export interface ChatContext {
  chatId: string;
  messages: ChatContextMessage[];
}
