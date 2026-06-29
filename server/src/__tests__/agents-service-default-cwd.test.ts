import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres default-cwd tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service company default cwd inheritance", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-default-cwd");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(defaultAgentCwd: string | null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workbench Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultAgentCwd,
    });
    return companyId;
  }

  it("inherits the company default cwd when the new agent has no explicit cwd", async () => {
    const companyId = await seedCompany("/home/tj/workbench");

    const created = await agentService(db).create(companyId, {
      name: "Backend",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { model: "" },
    });

    expect((created.adapterConfig as Record<string, unknown>).cwd).toBe("/home/tj/workbench");
  });

  it("inherits the default cwd when adapterConfig is omitted entirely", async () => {
    const companyId = await seedCompany("/home/tj/workbench");

    const created = await agentService(db).create(companyId, {
      name: "DevOps",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
    });

    expect((created.adapterConfig as Record<string, unknown>).cwd).toBe("/home/tj/workbench");
  });

  it("preserves an explicit cwd override and does not apply the company default", async () => {
    const companyId = await seedCompany("/home/tj/workbench");

    const created = await agentService(db).create(companyId, {
      name: "MeshPilot",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { cwd: "/home/tj/sandbox/mesh" },
    });

    expect((created.adapterConfig as Record<string, unknown>).cwd).toBe("/home/tj/sandbox/mesh");
  });

  it("does not set a cwd when the company has no default", async () => {
    const companyId = await seedCompany(null);

    const created = await agentService(db).create(companyId, {
      name: "Scout",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { model: "" },
    });

    expect((created.adapterConfig as Record<string, unknown>).cwd).toBeUndefined();
  });

  it("treats a blank-string cwd as unset and applies the company default", async () => {
    const companyId = await seedCompany("/home/tj/workbench");

    const created = await agentService(db).create(companyId, {
      name: "Frontend",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { cwd: "   " },
    });

    expect((created.adapterConfig as Record<string, unknown>).cwd).toBe("/home/tj/workbench");
  });

  it("exposes and updates the company default through the company service", async () => {
    const companyId = await seedCompany(null);

    const before = await companyService(db).getById(companyId);
    expect(before?.defaultAgentCwd).toBeNull();

    const updated = await companyService(db).update(companyId, {
      defaultAgentCwd: "/home/tj/workbench",
    });
    expect(updated?.defaultAgentCwd).toBe("/home/tj/workbench");

    // Backfill semantics: a newly hired agent now inherits the freshly set default.
    const created = await agentService(db).create(companyId, {
      name: "QA",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
    });
    expect((created.adapterConfig as Record<string, unknown>).cwd).toBe("/home/tj/workbench");

    const cleared = await companyService(db).update(companyId, { defaultAgentCwd: null });
    expect(cleared?.defaultAgentCwd).toBeNull();
  });
});
