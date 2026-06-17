import { describe, expect, it } from "vitest";
import { DEFAULT_MASTER_RUNTIME_FAILOVER, type MasterRuntimeFailoverSettings } from "@paperclipai/shared";
import {
  coerceMasterRuntimeFallbackConfig,
  isHardMasterRuntimeLimitResult,
  normalizeMasterRuntimeFailoverSettings,
  resolveMasterRuntimeAdapter,
} from "../services/heartbeat.js";

function settings(patch: Partial<MasterRuntimeFailoverSettings>): MasterRuntimeFailoverSettings {
  return {
    ...DEFAULT_MASTER_RUNTIME_FAILOVER,
    ...patch,
  };
}

describe("master runtime failover", () => {
  const now = new Date("2026-06-05T22:00:00.000Z");
  const future = "2026-06-06T04:00:00.000Z";
  const companyA = "00000000-0000-4000-8000-00000000000a";
  const companyB = "00000000-0000-4000-8000-00000000000b";

  it("routes Claude to Codex when Claude is limited for that company in auto mode", () => {
    expect(resolveMasterRuntimeAdapter({
      adapterType: "claude_local",
      settings: settings({
        companyLimits: {
          [companyA]: {
            claudeLimitedUntil: future,
            codexLimitedUntil: null,
            activeRuntime: "codex",
            reason: "claude_hard_limit",
            updatedAt: now.toISOString(),
          },
        },
      }),
      companyId: companyA,
      now,
    })).toMatchObject({
      sourceRuntime: "claude",
      targetRuntime: "codex",
      adapterType: "codex_local",
      blocked: false,
    });
  });

  it("routes Codex to Claude when Codex is limited for that company in auto mode", () => {
    expect(resolveMasterRuntimeAdapter({
      adapterType: "codex_local",
      settings: settings({
        companyLimits: {
          [companyA]: {
            claudeLimitedUntil: null,
            codexLimitedUntil: future,
            activeRuntime: "claude",
            reason: "codex_hard_limit",
            updatedAt: now.toISOString(),
          },
        },
      }),
      companyId: companyA,
      now,
    })).toMatchObject({
      sourceRuntime: "codex",
      targetRuntime: "claude",
      adapterType: "claude_local",
      blocked: false,
    });
  });

  it("does not apply one company's limit window to another company", () => {
    const sharedSettings = settings({
      companyLimits: {
        [companyA]: {
          claudeLimitedUntil: future,
          codexLimitedUntil: null,
          activeRuntime: "codex",
          reason: "claude_hard_limit",
          updatedAt: now.toISOString(),
        },
      },
    });

    expect(resolveMasterRuntimeAdapter({
      adapterType: "claude_local",
      settings: sharedSettings,
      companyId: companyB,
      now,
    })).toMatchObject({
      sourceRuntime: "claude",
      targetRuntime: "claude",
      adapterType: "claude_local",
      reason: null,
      blocked: false,
    });
  });

  it("preserves legacy top-level limit windows when no company context is supplied", () => {
    expect(resolveMasterRuntimeAdapter({
      adapterType: "claude_local",
      settings: settings({ claudeLimitedUntil: future }),
      now,
    })).toMatchObject({
      sourceRuntime: "claude",
      targetRuntime: "codex",
      adapterType: "codex_local",
      blocked: false,
    });
  });

  it("blocks instead of routing to non-master adapters when both masters are limited for that company", () => {
    expect(resolveMasterRuntimeAdapter({
      adapterType: "codex_local",
      settings: settings({
        companyLimits: {
          [companyA]: {
            claudeLimitedUntil: future,
            codexLimitedUntil: future,
            activeRuntime: null,
            reason: "codex_hard_limit",
            updatedAt: now.toISOString(),
          },
        },
      }),
      companyId: companyA,
      now,
    })).toMatchObject({
      sourceRuntime: "codex",
      targetRuntime: null,
      adapterType: "codex_local",
      reason: "both_master_runtimes_limited",
      blocked: true,
    });
  });

  it("does not rewrite non-master adapters", () => {
    expect(resolveMasterRuntimeAdapter({
      adapterType: "gemini_local",
      settings: settings({ claudeLimitedUntil: future }),
      now,
    })).toMatchObject({
      sourceRuntime: null,
      targetRuntime: null,
      adapterType: "gemini_local",
      blocked: false,
    });
  });

  it("honors force mode even when a runtime is marked limited", () => {
    expect(resolveMasterRuntimeAdapter({
      adapterType: "codex_local",
      settings: settings({
        mode: "force_claude",
        claudeLimitedUntil: future,
      }),
      now,
    })).toMatchObject({
      sourceRuntime: "codex",
      targetRuntime: "claude",
      adapterType: "claude_local",
      reason: "forced_claude_override",
      blocked: false,
    });
  });

  it("routes Claude agents through Codex in force_codex mode", () => {
    expect(resolveMasterRuntimeAdapter({
      adapterType: "claude_local",
      settings: settings({ mode: "force_codex" }),
      now,
    })).toMatchObject({
      sourceRuntime: "claude",
      targetRuntime: "codex",
      adapterType: "codex_local",
      reason: "forced_codex_override",
      blocked: false,
    });
  });

  it("detects hard usage limits even without transient_upstream classification", () => {
    expect(isHardMasterRuntimeLimitResult("claude_local", {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorMessage: "Claude usage limit reached. Resets at 3:15 AM (UTC).",
      errorFamily: null,
    })).toBe(true);

    expect(isHardMasterRuntimeLimitResult("codex_local", {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "codex_transient_upstream",
      errorMessage: "You've hit your usage limit for GPT-5. Switch to another model now, or try again at 11:31 PM.",
      retryNotBefore: "2026-06-06T03:31:00.000Z",
      errorFamily: null,
    })).toBe(true);
  });

  it("does not classify ordinary non-master or generic failures as hard master limits", () => {
    expect(isHardMasterRuntimeLimitResult("gemini_local", {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "429 RESOURCE_EXHAUSTED",
      retryNotBefore: "2026-06-06T03:31:00.000Z",
    })).toBe(false);

    expect(isHardMasterRuntimeLimitResult("claude_local", {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "temporary service unavailable",
      errorFamily: "transient_upstream",
    })).toBe(false);
  });

  it("clears stale active runtime when auto mode has no future limited windows", () => {
    expect(normalizeMasterRuntimeFailoverSettings(settings({
      activeRuntime: "codex",
      reason: "claude_hard_limit",
      claudeLimitedUntil: "2026-06-05T20:00:00.000Z",
    }), now)).toMatchObject({
      mode: "auto",
      activeRuntime: null,
      claudeLimitedUntil: null,
      codexLimitedUntil: null,
    });
  });

  it("drops expired company-scoped limits so future runs switch back to their source runtime", () => {
    const expired = "2026-06-05T20:00:00.000Z";
    const limitedSettings = settings({
      companyLimits: {
        [companyA]: {
          claudeLimitedUntil: expired,
          codexLimitedUntil: null,
          activeRuntime: "codex",
          reason: "claude_hard_limit",
          updatedAt: expired,
        },
      },
    });

    expect(normalizeMasterRuntimeFailoverSettings(limitedSettings, now)).not.toHaveProperty("companyLimits");
    expect(resolveMasterRuntimeAdapter({
      adapterType: "claude_local",
      settings: limitedSettings,
      companyId: companyA,
      now,
    })).toMatchObject({
      sourceRuntime: "claude",
      targetRuntime: "claude",
      adapterType: "claude_local",
      reason: null,
      blocked: false,
    });
  });

  it("only carries shared config fields across master runtimes", () => {
    expect(coerceMasterRuntimeFallbackConfig({
      sourceAdapterType: "claude_local",
      targetAdapterType: "codex_local",
      config: {
        cwd: "/repo",
        instructionsFilePath: "/repo/AGENTS.md",
        promptTemplate: "work",
        env: { SAFE: "1" },
        workspaceStrategy: { type: "git_worktree" },
        workspaceRuntime: { services: [] },
        timeoutSec: 120,
        graceSec: 5,
        model: "claude-opus-4-8",
        command: "claude",
        extraArgs: ["--danger"],
        futureClaudeOnlyFlag: true,
      },
    })).toEqual({
      cwd: "/repo",
      instructionsFilePath: "/repo/AGENTS.md",
      promptTemplate: "work",
      env: { SAFE: "1" },
      workspaceStrategy: { type: "git_worktree" },
      workspaceRuntime: { services: [] },
      timeoutSec: 120,
      graceSec: 5,
    });
  });
});
