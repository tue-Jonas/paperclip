import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import type {
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
            sql<number>`coalesce(sum(case when ${projects.status} not in ('done', 'cancelled') then 1 else 0 end), 0)`,
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

  async function getCompanyDetail(companyId: string): Promise<ManagementCompanyDetailResponse | null> {
    const [companySummary] = await listCompanySummaries([companyId]);
    if (!companySummary) return null;

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

    const [agentRows, projectRows, approvalRows] = await Promise.all([
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
      db
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
        .limit(DETAIL_APPROVAL_LIMIT),
    ]);

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
      approvals: mappedApprovals,
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
    getCompanyDetail,
    listCompanyIssues,
    listCompanyRuns,
    listCompanySummaries,
    toCompanyHealth,
  };
}
