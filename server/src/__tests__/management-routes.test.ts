import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  crossCompanyAgentGrants,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR } from "../services/cross-company-agent-grants.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
const TEST_SOURCE_COMPANY_ID = "11111111-1111-4111-8111-111111111111";

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { managementRoutes } = await import("../routes/management.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", managementRoutes(db));
  app.use("/api", approvalRoutes(db));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function seedCompany(db: Db, id: string | undefined, label: string) {
  return db
    .insert(companies)
    .values({
      ...(id ? { id } : {}),
      name: `Management ${label} ${randomUUID()}`,
      issuePrefix: `MG${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedAgent(
  db: Db,
  companyId: string,
  label: string,
  status = "idle",
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${label} ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      status,
      lastHeartbeatAt: new Date("2026-06-16T18:00:00.000Z"),
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedProject(db: Db, companyId: string, label: string, status = "in_progress") {
  return db
    .insert(projects)
    .values({
      companyId,
      name: `Project ${label} ${randomUUID()}`,
      status,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedIssue(db: Db, input: {
  companyId: string;
  projectId?: string | null;
  assigneeAgentId?: string | null;
  title: string;
  status: string;
  priority?: string;
  identifier: string;
}) {
  return db
    .insert(issues)
    .values({
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      title: input.title,
      status: input.status,
      priority: input.priority ?? "medium",
      identifier: input.identifier,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("management routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousAllowedSourceCompanyIds =
    process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-management-routes-");
    db = createDb(tempDb.connectionString);
    process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR] = TEST_SOURCE_COMPANY_ID;
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(crossCompanyAgentGrants);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousAllowedSourceCompanyIds === undefined) {
      delete process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR];
    } else {
      process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR] =
        previousAllowedSourceCompanyIds;
    }
    await tempDb?.cleanup();
  });

  it("lets granted source-company agents read cross-company management summaries without widening writes", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "Source");
    const targetCompany = await seedCompany(db, undefined, "Target");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "Source");
    const targetAgent = await seedAgent(db, targetCompany.id, "Target", "running");
    const targetProject = await seedProject(db, targetCompany.id, "Ops");
    await seedProject(db, targetCompany.id, "Completed", "completed");
    const blockerIssue = await seedIssue(db, {
      companyId: targetCompany.id,
      projectId: targetProject.id,
      assigneeAgentId: targetAgent.id,
      title: "Recover active run",
      status: "in_progress",
      identifier: `${targetCompany.issuePrefix}-1`,
    });
    const blockedIssue = await seedIssue(db, {
      companyId: targetCompany.id,
      projectId: targetProject.id,
      assigneeAgentId: targetAgent.id,
      title: "Cross-org blocker issue",
      status: "blocked",
      identifier: `${targetCompany.issuePrefix}-2`,
    });

    await db.insert(issueRelations).values({
      companyId: targetCompany.id,
      issueId: blockerIssue.id,
      relatedIssueId: blockedIssue.id,
      type: "blocks",
    });

    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: targetCompany.id,
        agentId: targetAgent.id,
        status: "running",
        invocationSource: "on_demand",
        livenessState: "blocked",
        startedAt: new Date("2026-06-16T18:05:00.000Z"),
        lastOutputAt: new Date("2026-06-16T18:10:00.000Z"),
        resultJson: { summary: "Run blocked on dependency", hidden: "nope" },
        contextSnapshot: { issueId: blockedIssue.id },
      })
      .returning()
      .then((rows) => rows[0]!);

    await db
      .update(issues)
      .set({ executionRunId: run.id })
      .where(eq(issues.id, blockedIssue.id));

    await db.insert(issueRecoveryActions).values({
      companyId: targetCompany.id,
      sourceIssueId: blockedIssue.id,
      kind: "active_run_watchdog",
      status: "active",
      cause: "stalled_run",
      fingerprint: `fp-${randomUUID()}`,
      nextAction: "Inspect blocked dependency",
      ownerAgentId: targetAgent.id,
      evidence: {},
    });

    await db.insert(approvals).values({
      companyId: targetCompany.id,
      type: "request_board_approval",
      requestedByAgentId: targetAgent.id,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        title: "Approve ops change",
        summary: "Need read-only confirmation",
        recommendedAction: "Keep it read-only",
        secret: "must-not-leak",
      },
    });

    await db.insert(crossCompanyAgentGrants).values({
      sourceCompanyId: sourceCompany.id,
      principalType: "agent",
      principalId: sourceAgent.id,
      targetCompanyId: targetCompany.id,
      capability: "read",
      status: "active",
    });

    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
    });

    const companiesRes = await request(app).get("/api/management/companies");
    expect(companiesRes.status, JSON.stringify(companiesRes.body)).toBe(200);
    expect(companiesRes.body.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: targetCompany.id,
        projectCount: 2,
        activeProjectCount: 1,
        blockedIssueCount: 1,
        pendingApprovalCount: 1,
        activeRunCount: 1,
        attentionRunCount: 1,
        recoveryActionCount: 1,
      }),
    ]));

    const detailRes = await request(app).get(`/api/management/companies/${targetCompany.id}`);
    expect(detailRes.status, JSON.stringify(detailRes.body)).toBe(200);
    expect(detailRes.body.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: targetAgent.id, companyId: targetCompany.id }),
    ]));
    expect(detailRes.body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: targetProject.id,
        openIssueCount: 2,
        blockedIssueCount: 1,
      }),
    ]));
    expect(detailRes.body.approvals).toEqual([]);

    const issuesRes = await request(app)
      .get(`/api/management/companies/${targetCompany.id}/issues`)
      .query({ status: "blocked" });
    expect(issuesRes.status, JSON.stringify(issuesRes.body)).toBe(200);
    expect(issuesRes.body.issues).toEqual([
      expect.objectContaining({
        id: blockedIssue.id,
        blockedByCount: 1,
        unresolvedBlockerCount: 1,
        blockedBy: [expect.objectContaining({ id: blockerIssue.id })],
        activeRecoveryAction: expect.objectContaining({
          kind: "active_run_watchdog",
          nextAction: "Inspect blocked dependency",
        }),
      }),
    ]);

    const runsRes = await request(app)
      .get(`/api/management/companies/${targetCompany.id}/runs`);
    expect(runsRes.status, JSON.stringify(runsRes.body)).toBe(403);
    expect(runsRes.body.error).toContain("management read boundary");

    const writeRes = await request(app)
      .post(`/api/companies/${targetCompany.id}/approvals`)
      .send({
        type: "request_board_approval",
        payload: { title: "Mutating write" },
      });
    expect(writeRes.status).toBe(403);
  }, 15_000);

  it("denies cross-company management reads without an active grant", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "SourceDenied");
    const targetCompany = await seedCompany(db, undefined, "TargetDenied");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "SourceDenied");
    const app = await createApp(db, {
      type: "agent",
      agentId: sourceAgent.id,
      companyId: sourceCompany.id,
    });

    const res = await request(app).get(`/api/management/companies/${targetCompany.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("management read boundary");
  }, 15_000);

  it("lets instance-admin board actors read management company summaries without grants", async () => {
    const targetCompany = await seedCompany(db, undefined, "BoardReadable");
    const app = await createApp(db, {
      type: "board",
      userId: "instance-admin",
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/management/companies");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: targetCompany.id }),
    ]));
  }, 15_000);
});
