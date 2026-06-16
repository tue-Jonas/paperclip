import type {
  AgentRole,
  AgentStatus,
  ApprovalStatus,
  CompanyStatus,
  HeartbeatRunStatus,
  IssuePriority,
  IssueRecoveryActionKind,
  IssueRecoveryActionStatus,
  IssueStatus,
  PauseReason,
  ProjectStatus,
  RunLivenessState,
} from "../constants.js";

export interface ManagementCompanyHealthSummary {
  activeRunCount: number;
  attentionRunCount: number;
  blockedIssueCount: number;
  recoveryActionCount: number;
  pendingApprovalCount: number;
  pausedAgentCount: number;
  lastRunStartedAt: Date | null;
}

export interface ManagementCompanySummary {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  agentCount: number;
  activeAgentCount: number;
  pausedAgentCount: number;
  projectCount: number;
  activeProjectCount: number;
  openIssueCount: number;
  blockedIssueCount: number;
  pendingApprovalCount: number;
  activeRunCount: number;
  attentionRunCount: number;
  recoveryActionCount: number;
  lastRunStartedAt: Date | null;
  updatedAt: Date;
}

export interface ManagementAgentSummary {
  id: string;
  companyId: string;
  name: string;
  role: AgentRole;
  title: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  lastHeartbeatAt: Date | null;
  updatedAt: Date;
}

export interface ManagementProjectSummary {
  id: string;
  companyId: string;
  goalId: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  leadAgentId: string | null;
  targetDate: string | null;
  openIssueCount: number;
  blockedIssueCount: number;
  updatedAt: Date;
}

export interface ManagementApprovalSummary {
  id: string;
  companyId: string;
  type: string;
  status: ApprovalStatus;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  payloadSummary: Record<string, unknown> | null;
}

export interface ManagementIssueBlockerSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

export interface ManagementIssueRecoverySummary {
  id: string;
  kind: IssueRecoveryActionKind;
  status: IssueRecoveryActionStatus;
  nextAction: string;
  ownerAgentId: string | null;
  timeoutAt: Date | null;
  updatedAt: Date;
}

export interface ManagementIssueSummary {
  id: string;
  identifier: string | null;
  companyId: string;
  projectId: string | null;
  projectName: string | null;
  parentId: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionRunId: string | null;
  monitorNextCheckAt: Date | null;
  blockedByCount: number;
  unresolvedBlockerCount: number;
  blockedBy: ManagementIssueBlockerSummary[];
  activeRecoveryAction: ManagementIssueRecoverySummary | null;
  updatedAt: Date;
}

export interface ManagementRunSummary {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string | null;
  status: HeartbeatRunStatus;
  livenessState: RunLivenessState | null;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastOutputAt: Date | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  errorCode: string | null;
  resultSummary: Record<string, unknown> | null;
}

export interface ManagementCompanyListResponse {
  companies: ManagementCompanySummary[];
}

export interface ManagementCompanyDetailResponse {
  company: ManagementCompanySummary;
  health: ManagementCompanyHealthSummary;
  agents: ManagementAgentSummary[];
  projects: ManagementProjectSummary[];
  approvals: ManagementApprovalSummary[];
}

export interface ManagementIssueListResponse {
  issues: ManagementIssueSummary[];
  nextOffset: number | null;
}

export interface ManagementRunListResponse {
  runs: ManagementRunSummary[];
  nextOffset: number | null;
}
