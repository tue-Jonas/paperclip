import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import type {
  ManagementAgentSummary,
  ManagementIssueSummary,
  ManagementProjectSummary,
} from "@paperclipai/shared";
import {
  managementIssueListQuerySchema,
  managementRunListQuerySchema,
} from "@paperclipai/shared";
import { accessService, managementService } from "../services/index.js";
import { assertBoardOrAgent } from "./authz.js";

export function managementRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const management = managementService(db);

  async function companyReadAllowed(req: Request, companyId: string) {
    return access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
  }

  function isCrossCompanyGrantRead(decision: Awaited<ReturnType<typeof companyReadAllowed>>) {
    return decision.allowed && Boolean(decision.crossCompanyGrant);
  }

  async function assertCompanyReadAllowed(req: Request, res: Response, companyId: string) {
    const decision = await companyReadAllowed(req, companyId);
    if (decision.allowed) return decision;
    res.status(403).json({ error: "Company is outside this actor's management read boundary" });
    return null;
  }

  async function listAccessibleCompanyIds(req: Request) {
    const rows = await db.select({ id: companies.id }).from(companies);
    const decisions = await Promise.all(rows.map((row) => companyReadAllowed(req, row.id)));
    return rows.filter((_, index) => decisions[index]?.allowed).map((row) => row.id);
  }

  async function filterIssuesForActor(req: Request, rows: ManagementIssueSummary[]) {
    const decisions = await Promise.all(rows.map((issue) => access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
    })));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  async function filterAgentsForActor(req: Request, rows: ManagementAgentSummary[]) {
    const decisions = await Promise.all(rows.map((agent) => access.decide({
      actor: req.actor,
      action: "agent:read",
      resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
    })));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  async function filterProjectsForActor(req: Request, rows: ManagementProjectSummary[]) {
    const decisions = await Promise.all(rows.map((project) => access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId: project.id },
    })));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  router.get("/management/companies", async (req, res) => {
    assertBoardOrAgent(req);
    const companyIds = await listAccessibleCompanyIds(req);
    const summaries = await management.listCompanySummaries(companyIds);
    res.json({ companies: summaries });
  });

  router.get("/management/companies/:companyId", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = req.params.companyId as string;
    const decision = await assertCompanyReadAllowed(req, res, companyId);
    if (!decision) return;

    const detail = await management.getCompanyDetail(companyId, {
      includeApprovals: !isCrossCompanyGrantRead(decision),
    });
    if (!detail) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    detail.agents = await filterAgentsForActor(req, detail.agents);
    detail.projects = await filterProjectsForActor(req, detail.projects);
    res.json(detail);
  });

  router.get("/management/companies/:companyId/issues", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = req.params.companyId as string;
    if (!(await assertCompanyReadAllowed(req, res, companyId))) return;

    const query = managementIssueListQuerySchema.parse(req.query);
    const result = await management.listCompanyIssues(companyId, query);
    res.json({
      issues: await filterIssuesForActor(req, result.issues),
      nextOffset: result.nextOffset,
    });
  });

  router.get("/management/companies/:companyId/runs", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = req.params.companyId as string;
    const decision = await assertCompanyReadAllowed(req, res, companyId);
    if (!decision) return;
    if (isCrossCompanyGrantRead(decision)) {
      res.status(403).json({ error: "Heartbeat runs are outside this actor's management read boundary" });
      return;
    }

    const query = managementRunListQuerySchema.parse(req.query);
    res.json(await management.listCompanyRuns(companyId, query));
  });

  return router;
}
