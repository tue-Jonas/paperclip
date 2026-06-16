import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  companies,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  projects,
  routineRuns,
  routines,
} from "@paperclipai/db";
import type {
  ManagementAnalyzerAccessSummary,
  ManagementAnalyzerActionCount,
  ManagementAnalyzerApprovalEvidence,
  ManagementAnalyzerBoardActionEvidence,
  ManagementAnalyzerBoardCommentEvidence,
  ManagementAnalyzerMetricSummary,
  ManagementAnalyzerRoutineRunEvidence,
  ManagementAnalyzerRunEvidence,
  ManagementAnalyzerSnapshotResponse,
  ManagementAnalyzerStatusChangeEvidence,
  ManagementAgentSummary,
  ManagementApprovalSummary,
  ManagementCompanyDetailResponse,
  ManagementCompanyHealthSummary,
  ManagementCompanySummary,
  ManagementIssueListQuery,
  ManagementIssueListResponse,
  ManagementIssueSummary,
  ManagementProjectSummary,
  ManagementRunListQuery,
  ManagementRunListResponse,
  ManagementRunSummary,
} from "@paperclipai/shared";
import { summarizeHeartbeatRunResultJson } from "./heartbeat-run-summary.js";

const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const DETAIL_AGENT_LIMIT = 25;
const DETAIL_PROJECT_LIMIT = 25;
const DETAIL_APPROVAL_LIMIT = 10;
const DEFAULT_STALE_WINDOW_HOURS = 24 * 3;
const ATTENTION_RUN_LIVENESS_STATES = ["blocked", "failed", "needs_followup", "empty_response"] as const;
const FAILED_HEARTBEAT_RUN_STATUSES = ["failed", "timed_out", "cancelled"] as const;

type CompanyCountRow = {
  companyId: string;
  openIssueCount?: number;
  blockedIssueCount?: number;
  agentCount?: number;
  activeAgentCount?: number;
  pausedAgentCount?: number;
  projectCount?: number;
  activeProjectCount?: number;
  pendingApprovalCount?: number;
  activeRunCount?: number;
  attentionRunCount?: number;
  recoveryActionCount?: number;
  lastRunStartedAt?: Date | null;
};

function summarizeApprovalPayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const summary: Record<string, unknown> = {};
  for (const key of ["title", "summary", "recommendedAction"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      summary[key] = value.length > 240 ? `${value.slice(0, 240)}...` : value;
    }
  }
  if (Array.isArray(payload.risks)) {
    summary.riskCount = payload.risks.length;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function readIssueIdFromRunContext(contextSnapshot: Record<string, unknown> | null | undefined) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const directIssueId = contextSnapshot.issueId;
  if (typeof directIssueId === "string" && directIssueId.trim().length > 0) return directIssueId;
  const nestedIssue =
    contextSnapshot.paperclipIssue &&
    typeof contextSnapshot.paperclipIssue === "object" &&
    !Array.isArray(contextSnapshot.paperclipIssue)
      ? (contextSnapshot.paperclipIssue as Record<string, unknown>)
      : null;
  const nestedIssueId = nestedIssue ? nestedIssue.id : null;
  return typeof nestedIssueId === "string" && nestedIssueId.trim().length > 0 ? nestedIssueId : null;
}

function mapByCompanyId(rows: CompanyCountRow[]) {
  return new Map(rows.map((row) => [row.companyId, row]));
}

function asNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function truncateExcerpt(text: string | null | undefined, max: number) {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

function issueAppPath(identifier: string | null) {
  if (!identifier) return null;
  const prefix = identifier.split("-")[0]?.trim();
  if (!prefix) return null;
  return `/${prefix}/issues/${identifier}`;
}

function issueApiPath(issueId: string) {
  return `/api/issues/${issueId}`;
}

function commentApiPath(issueId: string, commentId: string) {
  return `/api/issues/${issueId}/comments/${commentId}`;
}

function approvalApiPath(approvalId: string) {
  return `/api/approvals/${approvalId}`;
}

function runIssuesApiPath(runId: string) {
  return `/api/heartbeat-runs/${runId}/issues`;
}

function routineRunsApiPath(routineId: string) {
  return `/api/routines/${routineId}/runs`;
}

function summarizeApprovalPayloadForAnalyzer(payload: Record<string, unknown> | null | undefined) {
  return summarizeApprovalPayload(payload);
}

function summarizeActivityDetails(details: Record<string, unknown> | null | undefined) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "status",
    "assigneeAgentId",
    "assigneeUserId",
    "source",
    "interactionKind",
    "interactionStatus",
    "requestedByAgentId",
    "requesterAgentId",
    "decisionOwnerResolutionSource",
  ] as const) {
    const value = details[key];
    if (value !== undefined && value !== null && value !== "") {
      summary[key] = value;
    }
  }
  const previous =
    details._previous && typeof details._previous === "object" && !Array.isArray(details._previous)
      ? (details._previous as Record<string, unknown>)
      : null;
  if (previous) {
    const previousSummary: Record<string, unknown> = {};
    for (const key of ["status", "assigneeAgentId", "assigneeUserId"] as const) {
      const value = previous[key];
      if (value !== undefined && value !== null && value !== "") {
        previousSummary[key] = value;
      }
    }
    if (Object.keys(previousSummary).length > 0) {
      summary.previous = previousSummary;
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function toCompanyHealth(summary: ManagementCompanySummary): ManagementCompanyHealthSummary {
  return {
    activeRunCount: summary.activeRunCount,
    attentionRunCount: summary.attentionRunCount,
    blockedIssueCount: summary.blockedIssueCount,
    recoveryActionCount: summary.recoveryActionCount,
    pendingApprovalCount: summary.pendingApprovalCount,
    pausedAgentCount: summary.pausedAgentCount,
    lastRunStartedAt: summary.lastRunStartedAt,
  };
}

export function managementService(db: Db) {
  async function listCompanySummaries(companyIds: string[]): Promise<ManagementCompanySummary[]> {
    if (companyIds.length === 0) return [];

    const companyRows = await db
      .select({
        id: companies.id,
        name: companies.name,
        description: companies.description,
        status: companies.status,
        pauseReason: companies.pauseReason,
        pausedAt: companies.pausedAt,
        issuePrefix: companies.issuePrefix,
        updatedAt: companies.updatedAt,
      })
      .from(companies)
      .where(inArray(companies.id, companyIds))
      .orderBy(companies.name);

    const [
      issueCounts,
      agentCounts,
      projectCounts,
      approvalCounts,
      runCounts,
      recoveryCounts,
    ] = await Promise.all([
      db
        .select({
          companyId: issues.companyId,
          openIssueCount:
            sql<number>`coalesce(sum(case when ${issues.status} not in ('done', 'cancelled') then 1 else 0 end), 0)`,
          blockedIssueCount:
            sql<number>`coalesce(sum(case when ${issues.status} = 'blocked' then 1 else 0 end), 0)`,
        })
        .from(issues)
        .where(and(inArray(issues.companyId, companyIds), isNull(issues.hiddenAt)))
        .groupBy(issues.companyId),
      db
        .select({
          companyId: agents.companyId,
          agentCount: sql<number>`count(*)`,
          activeAgentCount:
            sql<number>`coalesce(sum(case when ${agents.status} not in ('terminated', 'pending_approval') then 1 else 0 end), 0)`,
          pausedAgentCount:
            sql<number>`coalesce(sum(case when ${agents.pausedAt} is not null then 1 else 0 end), 0)`,
        })
        .from(agents)
        .where(inArray(agents.companyId, companyIds))
        .groupBy(agents.companyId),
      db
        .select({
          companyId: projects.companyId,
          projectCount: sql<number>`count(*)`,
          activeProjectCount:
            sql<number>`coalesce(sum(case when ${projects.status} not in ('completed', 'cancelled') then 1 else 0 end), 0)`,
        })
        .from(projects)
        .where(inArray(projects.companyId, companyIds))
        .groupBy(projects.companyId),
      db
        .select({
          companyId: approvals.companyId,
          pendingApprovalCount:
            sql<number>`coalesce(sum(case when ${approvals.status} in ('pending', 'revision_requested') then 1 else 0 end), 0)`,
        })
        .from(approvals)
        .where(inArray(approvals.companyId, companyIds))
        .groupBy(approvals.companyId),
      db
        .select({
          companyId: heartbeatRuns.companyId,
          activeRunCount:
            sql<number>`coalesce(sum(case when ${heartbeatRuns.status} in ('queued', 'scheduled_retry', 'running') then 1 else 0 end), 0)`,
          attentionRunCount:
            sql<number>`coalesce(sum(case when ${heartbeatRuns.status} in ('queued', 'scheduled_retry', 'running') and ${heartbeatRuns.livenessState} in ('blocked', 'failed', 'needs_followup', 'empty_response') then 1 else 0 end), 0)`,
          lastRunStartedAt: sql<Date | null>`max(${heartbeatRuns.startedAt})`,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.companyId, companyIds))
        .groupBy(heartbeatRuns.companyId),
      db
        .select({
          companyId: issueRecoveryActions.companyId,
          recoveryActionCount:
            sql<number>`coalesce(sum(case when ${issueRecoveryActions.status} in ('active', 'escalated') then 1 else 0 end), 0)`,
        })
        .from(issueRecoveryActions)
        .where(inArray(issueRecoveryActions.companyId, companyIds))
        .groupBy(issueRecoveryActions.companyId),
    ]);

    const issueCountsByCompany = mapByCompanyId(issueCounts);
    const agentCountsByCompany = mapByCompanyId(agentCounts);
    const projectCountsByCompany = mapByCompanyId(projectCounts);
    const approvalCountsByCompany = mapByCompanyId(approvalCounts);
    const runCountsByCompany = mapByCompanyId(runCounts);
    const recoveryCountsByCompany = mapByCompanyId(recoveryCounts);

    return companyRows.map((row) => {
      const issueCount = issueCountsByCompany.get(row.id);
      const agentCount = agentCountsByCompany.get(row.id);
      const projectCount = projectCountsByCompany.get(row.id);
      const approvalCount = approvalCountsByCompany.get(row.id);
      const runCount = runCountsByCompany.get(row.id);
      const recoveryCount = recoveryCountsByCompany.get(row.id);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status as ManagementCompanySummary["status"],
        pauseReason: row.pauseReason as ManagementCompanySummary["pauseReason"],
        pausedAt: row.pausedAt,
        issuePrefix: row.issuePrefix,
        agentCount: asNumber(agentCount?.agentCount),
        activeAgentCount: asNumber(agentCount?.activeAgentCount),
        pausedAgentCount: asNumber(agentCount?.pausedAgentCount),
        projectCount: asNumber(projectCount?.projectCount),
        activeProjectCount: asNumber(projectCount?.activeProjectCount),
        openIssueCount: asNumber(issueCount?.openIssueCount),
        blockedIssueCount: asNumber(issueCount?.blockedIssueCount),
        pendingApprovalCount: asNumber(approvalCount?.pendingApprovalCount),
        activeRunCount: asNumber(runCount?.activeRunCount),
        attentionRunCount: asNumber(runCount?.attentionRunCount),
        recoveryActionCount: asNumber(recoveryCount?.recoveryActionCount),
        lastRunStartedAt: asDate(runCount?.lastRunStartedAt),
        updatedAt: row.updatedAt,
      };
    });
  }

  async function getCompanyAnalyzerSnapshot(
    companyId: string,
    input: {
      windowHours: number;
      evidenceLimit: number;
      access: ManagementAnalyzerAccessSummary;
    },
  ): Promise<ManagementAnalyzerSnapshotResponse | null> {
    const [companySummary] = await listCompanySummaries([companyId]);
    if (!companySummary) return null;

    const until = new Date();
    const since = new Date(until.getTime() - input.windowHours * 60 * 60 * 1000);
    const staleBefore = new Date(until.getTime() - DEFAULT_STALE_WINDOW_HOURS * 60 * 60 * 1000);

    const [
      currentIssueRows,
      recentActivityRows,
      boardCommentRows,
      heartbeatRunRows,
      routineRunRows,
      boardCommentEvidenceRows,
      approvalEvidenceRows,
      blockedIssues,
    ] = await Promise.all([
      db
        .select({
          id: issues.id,
          status: issues.status,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt))),
      db
        .select({
          activityId: activityLog.id,
          action: activityLog.action,
          actorType: activityLog.actorType,
          actorId: activityLog.actorId,
          entityType: activityLog.entityType,
          entityId: activityLog.entityId,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), gte(activityLog.createdAt, since)))
        .orderBy(desc(activityLog.createdAt)),
      db
        .select({
          commentId: issueComments.id,
        })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          gte(issueComments.createdAt, since),
          isNull(issueComments.deletedAt),
          sql`${issueComments.authorUserId} is not null`,
        )),
      db
        .select({
          runId: heartbeatRuns.id,
          status: heartbeatRuns.status,
          livenessState: heartbeatRuns.livenessState,
          invocationSource: heartbeatRuns.invocationSource,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          resultJson: heartbeatRuns.resultJson,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, since)))
        .orderBy(desc(heartbeatRuns.createdAt)),
      db
        .select({
          routineRunId: routineRuns.id,
          routineId: routineRuns.routineId,
          routineTitle: routines.title,
          status: routineRuns.status,
          source: routineRuns.source,
          triggeredAt: routineRuns.triggeredAt,
          failureReason: routineRuns.failureReason,
          linkedIssueId: routineRuns.linkedIssueId,
          linkedIssueIdentifier: issues.identifier,
          linkedIssueTitle: issues.title,
          createdAt: routineRuns.createdAt,
        })
        .from(routineRuns)
        .innerJoin(routines, eq(routines.id, routineRuns.routineId))
        .leftJoin(issues, eq(issues.id, routineRuns.linkedIssueId))
        .where(and(eq(routineRuns.companyId, companyId), gte(routineRuns.createdAt, since)))
        .orderBy(desc(routineRuns.createdAt)),
      db
        .select({
          commentId: issueComments.id,
          issueId: issueComments.issueId,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          createdAt: issueComments.createdAt,
          authorUserId: issueComments.authorUserId,
          body: issueComments.body,
        })
        .from(issueComments)
        .innerJoin(issues, eq(issues.id, issueComments.issueId))
        .where(and(
          eq(issueComments.companyId, companyId),
          eq(issues.companyId, companyId),
          isNull(issueComments.deletedAt),
          gte(issueComments.createdAt, since),
          sql`${issueComments.authorUserId} is not null`,
        ))
        .orderBy(desc(issueComments.createdAt))
        .limit(input.evidenceLimit),
      db
        .select({
          approvalId: approvals.id,
          type: approvals.type,
          status: approvals.status,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          decidedByUserId: approvals.decidedByUserId,
          createdAt: approvals.createdAt,
          decidedAt: approvals.decidedAt,
          payload: approvals.payload,
        })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), gte(approvals.updatedAt, since)))
        .orderBy(desc(approvals.updatedAt))
        .limit(input.evidenceLimit),
      listCompanyIssues(companyId, {
        status: "blocked",
        limit: input.evidenceLimit,
        offset: 0,
      }).then((result) => result.issues),
    ]);

    const boardActionBreakdownMap = new Map<string, number>();
    const approvalActionCountByAction = new Map<string, number>();
    for (const row of recentActivityRows) {
      if (row.actorType === "user" && row.action !== "issue.comment_added") {
        boardActionBreakdownMap.set(row.action, (boardActionBreakdownMap.get(row.action) ?? 0) + 1);
      }
      if (["approval.created", "approval.approved", "approval.rejected", "approval.revision_requested"].includes(row.action)) {
        approvalActionCountByAction.set(row.action, (approvalActionCountByAction.get(row.action) ?? 0) + 1);
      }
    }
    const boardActionBreakdown: ManagementAnalyzerActionCount[] = Array.from(boardActionBreakdownMap.entries())
      .map(([action, count]) => ({ action, count }))
      .sort((left, right) => right.count - left.count || left.action.localeCompare(right.action));
    const boardActionCount = boardActionBreakdown.reduce((sum, row) => sum + row.count, 0);

    const issueUpdateActivities = recentActivityRows.filter((row) => row.entityType === "issue" && row.action === "issue.updated");
    const statusChangeRows = issueUpdateActivities.filter((row) => {
      const details =
        row.details && typeof row.details === "object" && !Array.isArray(row.details)
          ? row.details as Record<string, unknown>
          : {};
      const previous =
        details._previous && typeof details._previous === "object" && !Array.isArray(details._previous)
          ? details._previous as Record<string, unknown>
          : {};
      return String(details.status ?? "") !== String(previous.status ?? "") ||
        String(details.assigneeAgentId ?? "") !== String(previous.assigneeAgentId ?? "") ||
        String(details.assigneeUserId ?? "") !== String(previous.assigneeUserId ?? "");
    });
    const statusChangeEvidenceRows = statusChangeRows.slice(0, input.evidenceLimit);
    const attentionRunRows = heartbeatRunRows
      .filter((row) =>
        ATTENTION_RUN_LIVENESS_STATES.includes((row.livenessState ?? "") as typeof ATTENTION_RUN_LIVENESS_STATES[number]) ||
        FAILED_HEARTBEAT_RUN_STATUSES.includes(row.status as typeof FAILED_HEARTBEAT_RUN_STATUSES[number]))
      .slice(0, input.evidenceLimit);
    const routineRunEvidenceRows = routineRunRows.slice(0, input.evidenceLimit);

    const issueIdsForActionEvidence = Array.from(new Set([
      ...recentActivityRows
        .filter((row) => row.actorType === "user" && row.action !== "issue.comment_added" && row.entityType === "issue")
        .slice(0, input.evidenceLimit)
        .map((row) => row.entityId),
      ...statusChangeEvidenceRows.map((row) => row.entityId),
      ...attentionRunRows
        .map((row) => readIssueIdFromRunContext(row.contextSnapshot))
        .filter((value): value is string => Boolean(value)),
    ]));
    const evidenceIssues = issueIdsForActionEvidence.length === 0
      ? []
      : await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIdsForActionEvidence)));
    const evidenceIssueById = new Map(evidenceIssues.map((row) => [row.id, row]));

    const boardComments: ManagementAnalyzerBoardCommentEvidence[] = boardCommentEvidenceRows.map((row) => ({
      commentId: row.commentId,
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier,
      issueTitle: row.issueTitle,
      createdAt: row.createdAt,
      authorUserId: row.authorUserId,
      bodyExcerpt: truncateExcerpt(row.body, input.access.excerptPolicy === "full" ? 280 : 140),
      issueApiPath: issueApiPath(row.issueId),
      commentApiPath: commentApiPath(row.issueId, row.commentId),
      issueAppPath: issueAppPath(row.issueIdentifier),
    }));

    const boardActions: ManagementAnalyzerBoardActionEvidence[] = recentActivityRows
      .filter((row) => row.actorType === "user" && row.action !== "issue.comment_added")
      .slice(0, input.evidenceLimit)
      .map((row) => {
        const linkedIssue = row.entityType === "issue" ? evidenceIssueById.get(row.entityId) ?? null : null;
        return {
          activityId: row.activityId,
          action: row.action,
          createdAt: row.createdAt,
          entityType: row.entityType,
          entityId: row.entityId,
          issueId: linkedIssue?.id ?? null,
          issueIdentifier: linkedIssue?.identifier ?? null,
          issueTitle: linkedIssue?.title ?? null,
          detailsSummary: summarizeActivityDetails(row.details),
          issueApiPath: linkedIssue ? issueApiPath(linkedIssue.id) : null,
          issueAppPath: linkedIssue ? issueAppPath(linkedIssue.identifier) : null,
        };
      });

    const statusChanges: ManagementAnalyzerStatusChangeEvidence[] = statusChangeEvidenceRows.map((row) => {
      const linkedIssue = evidenceIssueById.get(row.entityId);
      const details =
        row.details && typeof row.details === "object" && !Array.isArray(row.details)
          ? row.details as Record<string, unknown>
          : {};
      const previous =
        details._previous && typeof details._previous === "object" && !Array.isArray(details._previous)
          ? details._previous as Record<string, unknown>
          : {};
      return {
        activityId: row.activityId,
        createdAt: row.createdAt,
        issueId: row.entityId,
        issueIdentifier: linkedIssue?.identifier ?? null,
        issueTitle: linkedIssue?.title ?? "Issue update",
        actorType: row.actorType as ManagementAnalyzerStatusChangeEvidence["actorType"],
        actorId: row.actorId,
        status: typeof details.status === "string" ? details.status : null,
        previousStatus: typeof previous.status === "string" ? previous.status : null,
        assigneeAgentId: typeof details.assigneeAgentId === "string" ? details.assigneeAgentId : null,
        previousAssigneeAgentId: typeof previous.assigneeAgentId === "string" ? previous.assigneeAgentId : null,
        assigneeUserId: typeof details.assigneeUserId === "string" ? details.assigneeUserId : null,
        previousAssigneeUserId: typeof previous.assigneeUserId === "string" ? previous.assigneeUserId : null,
        issueApiPath: issueApiPath(row.entityId),
        issueAppPath: issueAppPath(linkedIssue?.identifier ?? null),
      };
    });

    const approvalEvidence: ManagementAnalyzerApprovalEvidence[] = approvalEvidenceRows.map((row) => ({
      approvalId: row.approvalId,
      type: row.type,
      status: row.status as ManagementAnalyzerApprovalEvidence["status"],
      requestedByAgentId: row.requestedByAgentId,
      requestedByUserId: row.requestedByUserId,
      decidedByUserId: row.decidedByUserId,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      payloadSummary: summarizeApprovalPayloadForAnalyzer(row.payload),
      approvalApiPath: approvalApiPath(row.approvalId),
    }));

    const attentionRuns: ManagementAnalyzerRunEvidence[] = attentionRunRows.map((row) => {
      const linkedIssueId = readIssueIdFromRunContext(row.contextSnapshot);
      const linkedIssue = linkedIssueId ? evidenceIssueById.get(linkedIssueId) ?? null : null;
      return {
        runId: row.runId,
        status: row.status as ManagementAnalyzerRunEvidence["status"],
        livenessState: row.livenessState as ManagementAnalyzerRunEvidence["livenessState"],
        invocationSource: row.invocationSource,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        issueId: linkedIssueId,
        issueIdentifier: linkedIssue?.identifier ?? null,
        issueTitle: linkedIssue?.title ?? null,
        resultSummary: summarizeHeartbeatRunResultJson(row.resultJson),
        runIssuesApiPath: runIssuesApiPath(row.runId),
        issueApiPath: linkedIssueId ? issueApiPath(linkedIssueId) : null,
        issueAppPath: issueAppPath(linkedIssue?.identifier ?? null),
      };
    });

    const routineRunsEvidence: ManagementAnalyzerRoutineRunEvidence[] = routineRunEvidenceRows.map((row) => ({
      routineRunId: row.routineRunId,
      routineId: row.routineId,
      routineTitle: row.routineTitle,
      status: row.status,
      source: row.source,
      triggeredAt: row.triggeredAt,
      failureReason: row.failureReason,
      linkedIssueId: row.linkedIssueId,
      linkedIssueIdentifier: row.linkedIssueIdentifier,
      linkedIssueTitle: row.linkedIssueTitle,
      routineRunsApiPath: routineRunsApiPath(row.routineId),
      issueApiPath: row.linkedIssueId ? issueApiPath(row.linkedIssueId) : null,
      issueAppPath: issueAppPath(row.linkedIssueIdentifier),
    }));

    const metrics: ManagementAnalyzerMetricSummary = {
      openIssueCount: companySummary.openIssueCount,
      blockedIssueCount: companySummary.blockedIssueCount,
      staleOpenIssueCount: currentIssueRows.filter((row) =>
        row.status !== "done" && row.status !== "cancelled" && row.updatedAt < staleBefore).length,
      issuesCreated: currentIssueRows.filter((row) => row.createdAt >= since).length,
      issuesCompleted: issueUpdateActivities.filter((row) => {
        const details = row.details as Record<string, unknown> | null;
        const previous =
          details?._previous && typeof details._previous === "object" && !Array.isArray(details._previous)
            ? details._previous as Record<string, unknown>
            : {};
        return details?.status === "done" && previous.status !== "done";
      }).length,
      issuesMovedToBlocked: issueUpdateActivities.filter((row) => {
        const details = row.details as Record<string, unknown> | null;
        const previous =
          details?._previous && typeof details._previous === "object" && !Array.isArray(details._previous)
            ? details._previous as Record<string, unknown>
            : {};
        return details?.status === "blocked" && previous.status !== "blocked";
      }).length,
      issuesCancelled: issueUpdateActivities.filter((row) => {
        const details = row.details as Record<string, unknown> | null;
        const previous =
          details?._previous && typeof details._previous === "object" && !Array.isArray(details._previous)
            ? details._previous as Record<string, unknown>
            : {};
        return details?.status === "cancelled" && previous.status !== "cancelled";
      }).length,
      issuesReopened: issueUpdateActivities.filter((row) => {
        const details = row.details as Record<string, unknown> | null;
        const previous =
          details?._previous && typeof details._previous === "object" && !Array.isArray(details._previous)
            ? details._previous as Record<string, unknown>
            : {};
        return ["todo", "in_progress", "in_review"].includes(String(details?.status ?? "")) &&
          ["done", "cancelled", "blocked"].includes(String(previous.status ?? ""));
      }).length,
      statusChangeCount: statusChangeRows.filter((row) => {
        const details = row.details as Record<string, unknown> | null;
        const previous =
          details?._previous && typeof details._previous === "object" && !Array.isArray(details._previous)
            ? details._previous as Record<string, unknown>
            : {};
        return String(details?.status ?? "") !== String(previous.status ?? "");
      }).length,
      assignmentChangeCount: statusChangeRows.filter((row) => {
        const details = row.details as Record<string, unknown> | null;
        const previous =
          details?._previous && typeof details._previous === "object" && !Array.isArray(details._previous)
            ? details._previous as Record<string, unknown>
            : {};
        return String(details?.assigneeAgentId ?? "") !== String(previous.assigneeAgentId ?? "") ||
          String(details?.assigneeUserId ?? "") !== String(previous.assigneeUserId ?? "");
      }).length,
      boardCommentCount: boardCommentRows.length,
      boardActionCount,
      approvalCreatedCount: approvalActionCountByAction.get("approval.created") ?? 0,
      approvalApprovedCount: approvalActionCountByAction.get("approval.approved") ?? 0,
      approvalRejectedCount: approvalActionCountByAction.get("approval.rejected") ?? 0,
      approvalRevisionRequestedCount: approvalActionCountByAction.get("approval.revision_requested") ?? 0,
      activeApprovalCount: companySummary.pendingApprovalCount,
      heartbeatRunCount: heartbeatRunRows.length,
      attentionHeartbeatRunCount: attentionRunRows.length,
      failedHeartbeatRunCount: heartbeatRunRows.filter((row) =>
        FAILED_HEARTBEAT_RUN_STATUSES.includes(row.status as typeof FAILED_HEARTBEAT_RUN_STATUSES[number])).length,
      routineRunCount: routineRunRows.length,
      failedRoutineRunCount: routineRunRows.filter((row) => row.status === "failed").length,
    };

    return {
      company: companySummary,
      health: toCompanyHealth(companySummary),
      window: {
        since,
        until,
        hours: input.windowHours,
      },
      access: input.access,
      metrics,
      boardActionBreakdown,
      evidence: {
        boardComments,
        boardActions,
        statusChanges,
        approvals: approvalEvidence,
        attentionRuns,
        routineRuns: routineRunsEvidence,
        blockedIssues,
      },
    };
  }

  async function getCompanyDetail(
    companyId: string,
    options: { includeApprovals?: boolean } = {},
  ): Promise<ManagementCompanyDetailResponse | null> {
    const [companySummary] = await listCompanySummaries([companyId]);
    if (!companySummary) return null;
    const includeApprovals = options.includeApprovals ?? true;

    const projectIssueCounts = await db
      .select({
        projectId: issues.projectId,
        openIssueCount:
          sql<number>`coalesce(sum(case when ${issues.status} not in ('done', 'cancelled') then 1 else 0 end), 0)`,
        blockedIssueCount:
          sql<number>`coalesce(sum(case when ${issues.status} = 'blocked' then 1 else 0 end), 0)`,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
      .groupBy(issues.projectId);
    const projectCountsById = new Map(
      projectIssueCounts
        .filter((row) => row.projectId)
        .map((row) => [row.projectId as string, row]),
    );

    const [agentRows, projectRows] = await Promise.all([
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          status: agents.status,
          reportsTo: agents.reportsTo,
          lastHeartbeatAt: agents.lastHeartbeatAt,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .orderBy(desc(agents.updatedAt))
        .limit(DETAIL_AGENT_LIMIT),
      db
        .select({
          id: projects.id,
          companyId: projects.companyId,
          goalId: projects.goalId,
          name: projects.name,
          description: projects.description,
          status: projects.status,
          leadAgentId: projects.leadAgentId,
          targetDate: projects.targetDate,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(eq(projects.companyId, companyId))
        .orderBy(desc(projects.updatedAt))
        .limit(DETAIL_PROJECT_LIMIT),
    ]);

    const approvalRows = includeApprovals
      ? await db
        .select({
          id: approvals.id,
          companyId: approvals.companyId,
          type: approvals.type,
          status: approvals.status,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
          payload: approvals.payload,
        })
        .from(approvals)
        .where(eq(approvals.companyId, companyId))
        .orderBy(desc(approvals.createdAt))
        .limit(DETAIL_APPROVAL_LIMIT)
      : [];

    const mappedAgents: ManagementAgentSummary[] = agentRows.map((row) => ({
      ...row,
      role: row.role as ManagementAgentSummary["role"],
      status: row.status as ManagementAgentSummary["status"],
    }));

    const mappedProjects: ManagementProjectSummary[] = projectRows.map((row) => {
      const counts = projectCountsById.get(row.id);
      return {
        ...row,
        status: row.status as ManagementProjectSummary["status"],
        targetDate: row.targetDate,
        openIssueCount: asNumber(counts?.openIssueCount),
        blockedIssueCount: asNumber(counts?.blockedIssueCount),
      };
    });

    const mappedApprovals: ManagementApprovalSummary[] = approvalRows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      type: row.type,
      status: row.status as ManagementApprovalSummary["status"],
      requestedByAgentId: row.requestedByAgentId,
      requestedByUserId: row.requestedByUserId,
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      payloadSummary: summarizeApprovalPayload(row.payload),
    }));

    return {
      company: companySummary,
      health: toCompanyHealth(companySummary),
      agents: mappedAgents,
      projects: mappedProjects,
      approvals: includeApprovals ? mappedApprovals : [],
    };
  }

  async function listCompanyIssues(
    companyId: string,
    query: ManagementIssueListQuery,
  ): Promise<ManagementIssueListResponse> {
    const projectAlias = alias(projects, "management_issue_project");
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        companyId: issues.companyId,
        projectId: issues.projectId,
        projectName: projectAlias.name,
        parentId: issues.parentId,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionRunId: issues.executionRunId,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .leftJoin(projectAlias, eq(projectAlias.id, issues.projectId))
      .where(and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        query.status ? eq(issues.status, query.status) : undefined,
      ))
      .orderBy(desc(issues.updatedAt))
      .limit(query.limit + 1)
      .offset(query.offset);

    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const issueIds = pageRows.map((row) => row.id);
    if (issueIds.length === 0) {
      return { issues: [], nextOffset: hasMore ? query.offset + query.limit : null };
    }

    const blockerAlias = alias(issues, "management_blocker_issue");
    const [blockerRows, recoveryRows] = await Promise.all([
      db
        .select({
          blockedIssueId: issueRelations.relatedIssueId,
          blockerId: blockerAlias.id,
          blockerIdentifier: blockerAlias.identifier,
          blockerTitle: blockerAlias.title,
          blockerStatus: blockerAlias.status,
        })
        .from(issueRelations)
        .innerJoin(blockerAlias, eq(blockerAlias.id, issueRelations.issueId))
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, issueIds),
        )),
      db
        .select({
          id: issueRecoveryActions.id,
          sourceIssueId: issueRecoveryActions.sourceIssueId,
          kind: issueRecoveryActions.kind,
          status: issueRecoveryActions.status,
          nextAction: issueRecoveryActions.nextAction,
          ownerAgentId: issueRecoveryActions.ownerAgentId,
          timeoutAt: issueRecoveryActions.timeoutAt,
          updatedAt: issueRecoveryActions.updatedAt,
        })
        .from(issueRecoveryActions)
        .where(and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, issueIds),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        )),
    ]);

    const blockersByIssueId = new Map<string, ManagementIssueSummary["blockedBy"]>();
    const unresolvedBlockerCounts = new Map<string, number>();
    for (const row of blockerRows) {
      const list = blockersByIssueId.get(row.blockedIssueId) ?? [];
      list.push({
        id: row.blockerId,
        identifier: row.blockerIdentifier,
        title: row.blockerTitle,
        status: row.blockerStatus as ManagementIssueSummary["blockedBy"][number]["status"],
      });
      blockersByIssueId.set(row.blockedIssueId, list);
      if (!TERMINAL_ISSUE_STATUSES.has(row.blockerStatus)) {
        unresolvedBlockerCounts.set(
          row.blockedIssueId,
          (unresolvedBlockerCounts.get(row.blockedIssueId) ?? 0) + 1,
        );
      }
    }

    const recoveryByIssueId = new Map<string, ManagementIssueSummary["activeRecoveryAction"]>(
      recoveryRows.map((row) => [row.sourceIssueId, {
        id: row.id,
        kind: row.kind as NonNullable<ManagementIssueSummary["activeRecoveryAction"]>["kind"],
        status: row.status as NonNullable<ManagementIssueSummary["activeRecoveryAction"]>["status"],
        nextAction: row.nextAction,
        ownerAgentId: row.ownerAgentId,
        timeoutAt: row.timeoutAt,
        updatedAt: row.updatedAt,
      }]),
    );

    return {
      issues: pageRows.map((row) => {
        const blockedBy = blockersByIssueId.get(row.id) ?? [];
        return {
          id: row.id,
          identifier: row.identifier,
          companyId: row.companyId,
          projectId: row.projectId,
          projectName: row.projectName,
          parentId: row.parentId,
          title: row.title,
          status: row.status as ManagementIssueSummary["status"],
          priority: row.priority as ManagementIssueSummary["priority"],
          assigneeAgentId: row.assigneeAgentId,
          assigneeUserId: row.assigneeUserId,
          executionRunId: row.executionRunId,
          monitorNextCheckAt: row.monitorNextCheckAt,
          blockedByCount: blockedBy.length,
          unresolvedBlockerCount: unresolvedBlockerCounts.get(row.id) ?? 0,
          blockedBy,
          activeRecoveryAction: recoveryByIssueId.get(row.id) ?? null,
          updatedAt: row.updatedAt,
        };
      }),
      nextOffset: hasMore ? query.offset + query.limit : null,
    };
  }

  async function listCompanyRuns(
    companyId: string,
    query: ManagementRunListQuery,
  ): Promise<ManagementRunListResponse> {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        query.status ? eq(heartbeatRuns.status, query.status) : undefined,
        query.activeOnly ? inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES) : undefined,
      ))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(query.limit + 1)
      .offset(query.offset);

    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const issueIds = Array.from(new Set(pageRows.map((row) => readIssueIdFromRunContext(row.contextSnapshot)).filter(Boolean)));
    const issueRows = issueIds.length > 0
      ? await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds as string[])))
      : [];
    const issueById = new Map(issueRows.map((row) => [row.id, row]));

    return {
      runs: pageRows.map((row) => {
        const issueId = readIssueIdFromRunContext(row.contextSnapshot);
        const issue = issueId ? issueById.get(issueId) ?? null : null;
        return {
          id: row.id,
          companyId: row.companyId,
          agentId: row.agentId,
          agentName: row.agentName,
          status: row.status as ManagementRunSummary["status"],
          livenessState: row.livenessState as ManagementRunSummary["livenessState"],
          invocationSource: row.invocationSource,
          triggerDetail: row.triggerDetail,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          lastOutputAt: row.lastOutputAt,
          issueId: issue?.id ?? issueId,
          issueIdentifier: issue?.identifier ?? null,
          issueTitle: issue?.title ?? null,
          errorCode: row.errorCode,
          resultSummary: summarizeHeartbeatRunResultJson(row.resultJson),
        };
      }),
      nextOffset: hasMore ? query.offset + query.limit : null,
    };
  }

  return {
    getCompanyAnalyzerSnapshot,
    getCompanyDetail,
    listCompanyIssues,
    listCompanyRuns,
    listCompanySummaries,
    toCompanyHealth,
  };
}
