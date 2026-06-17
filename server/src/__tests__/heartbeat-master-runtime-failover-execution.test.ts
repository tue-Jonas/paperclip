import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentRuntimeState,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { DEFAULT_MASTER_RUNTIME_FAILOVER } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const adapterExecute = vi.hoisted(() => vi.fn(async (input: {
  agent: { adapterType: string; adapterConfig: Record<string, unknown> | null };
  config: Record<string, unknown>;
  context: Record<string, unknown>;
}) => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: `${input.agent.adapterType}-session` },
  sessionDisplayId: `${input.agent.adapterType}-session`,
  provider: input.agent.adapterType,
  model: "test-model",
  resultJson: {
    adapterType: input.agent.adapterType,
    promptTemplate: input.config.promptTemplate,
    masterRuntime: input.context.paperclipMasterRuntime,
  },
})));

const requestedAdapterTypes = vi.hoisted(() => [] as string[]);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: (adapterType: string) => {
    requestedAdapterTypes.push(adapterType);
    return {
      type: adapterType,
      execute: adapterExecute,
      supportsLocalAgentJwt: false,
    };
  },
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat master-runtime execution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat master runtime failover execution", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-master-runtime-failover-execution");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    requestedAdapterTypes.length = 0;
    await vi.waitFor(async () => {
      const active = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .then((rows) => rows.filter((row) => row.status === "queued" || row.status === "running"));
      expect(active).toHaveLength(0);
    }, { timeout: 5_000 });
    await db.execute(sql.raw(`
      SET client_min_messages TO warning;
      TRUNCATE TABLE
        "activity_log",
        "environment_leases",
        "environments",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies",
        "instance_settings"
      RESTART IDENTITY CASCADE;
      SET client_min_messages TO notice;
    `));
  });

  afterAll(async () => {
    await db.$client.end();
    await stopDb?.();
  });

  it("executes a limited Claude agent through Codex while preserving source ownership", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
        timeoutSec: 90,
        model: "claude-should-not-leak",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await instanceSettingsService(db).updateExperimental({
      masterRuntimeFailover: {
        ...DEFAULT_MASTER_RUNTIME_FAILOVER,
        companyLimits: {
          [companyId]: {
            claudeLimitedUntil: "2099-01-01T00:00:00.000Z",
            codexLimitedUntil: null,
            activeRuntime: "codex",
            reason: "claude_hard_limit",
            updatedAt: "2026-06-15T00:00:00.000Z",
          },
        },
      },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: {},
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 5_000 });

    expect(requestedAdapterTypes).toContain("codex_local");
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(adapterExecute.mock.calls[0]?.[0]).toMatchObject({
      agent: {
        id: agentId,
        adapterType: "codex_local",
        adapterConfig: {
          promptTemplate: "Follow the heartbeat.",
          timeoutSec: 90,
        },
      },
      config: {
        promptTemplate: "Follow the heartbeat.",
        timeoutSec: 90,
      },
      context: {
        paperclipMasterRuntime: {
          sourceAdapterType: "claude_local",
          executionAdapterType: "codex_local",
          sourceRuntime: "claude",
          targetRuntime: "codex",
          reason: "claude_limited_failover_to_codex",
        },
      },
    });
    expect(adapterExecute.mock.calls[0]?.[0].agent.adapterConfig).not.toHaveProperty("model");

    const sourceAgent = await db
      .select({ adapterType: agents.adapterType })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(sourceAgent?.adapterType).toBe("claude_local");

    await vi.waitFor(async () => {
      const runtimeState = await db
        .select({ adapterType: agentRuntimeState.adapterType, sessionId: agentRuntimeState.sessionId })
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      expect(runtimeState).toMatchObject({
        adapterType: "codex_local",
        sessionId: "codex_local-session",
      });
    }, { timeout: 5_000 });

    const persistedRun = await heartbeat.getRun(run!.id);
    expect(persistedRun?.agentId).toBe(agentId);
    expect(persistedRun?.resultJson).toMatchObject({
      stopReason: "completed",
      adapterType: "codex_local",
      promptTemplate: "Follow the heartbeat.",
      masterRuntime: {
        executionAdapterType: "codex_local",
      },
    });
    expect(persistedRun?.contextSnapshot).toMatchObject({
      paperclipMasterRuntime: {
        executionAdapterType: "codex_local",
      },
    });
  }, 15_000);

  it("keeps master-runtime cooldowns isolated between companies", async () => {
    const limitedCompanyId = randomUUID();
    const healthyCompanyId = randomUUID();
    const limitedAgentId = randomUUID();
    const healthyAgentId = randomUUID();

    await db.insert(companies).values([
      {
        id: limitedCompanyId,
        name: "Limited Co",
        issuePrefix: `L${limitedCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: healthyCompanyId,
        name: "Healthy Co",
        issuePrefix: `H${healthyCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: limitedAgentId,
        companyId: limitedCompanyId,
        name: "LimitedClaude",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { promptTemplate: "limited" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: healthyAgentId,
        companyId: healthyCompanyId,
        name: "HealthyClaude",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { promptTemplate: "healthy" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await instanceSettingsService(db).updateExperimental({
      masterRuntimeFailover: {
        ...DEFAULT_MASTER_RUNTIME_FAILOVER,
        companyLimits: {
          [limitedCompanyId]: {
            claudeLimitedUntil: "2099-01-01T00:00:00.000Z",
            codexLimitedUntil: null,
            activeRuntime: "codex",
            reason: "claude_hard_limit",
            updatedAt: "2026-06-15T00:00:00.000Z",
          },
        },
      },
    });

    const heartbeat = heartbeatService(db);
    const limitedRun = await heartbeat.wakeup(limitedAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: {},
    });
    const healthyRun = await heartbeat.wakeup(healthyAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: {},
    });

    expect(limitedRun).not.toBeNull();
    expect(healthyRun).not.toBeNull();
    await vi.waitFor(async () => {
      expect((await heartbeat.getRun(limitedRun!.id))?.status).toBe("succeeded");
      expect((await heartbeat.getRun(healthyRun!.id))?.status).toBe("succeeded");
    }, { timeout: 5_000 });

    expect(adapterExecute).toHaveBeenCalledTimes(2);
    expect(adapterExecute.mock.calls.map((call) => call[0].agent.adapterType).sort()).toEqual([
      "claude_local",
      "codex_local",
    ]);
    const healthyCall = adapterExecute.mock.calls.find((call) => call[0].agent.id === healthyAgentId);
    expect(healthyCall?.[0]).toMatchObject({
      agent: {
        adapterType: "claude_local",
      },
    });
    expect(healthyCall?.[0].context).not.toHaveProperty("paperclipMasterRuntime");
  }, 15_000);
});
