import { describe, expect, it, vi } from "vitest";

import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../src/protocol.js";

describe("createHostClientHandlers invocation company scope", () => {
  it("rejects company-scoped host calls outside the current invocation company", async () => {
    const projectsList = vi.fn(async () => []);
    const services = {
      projects: {
        list: projectsList,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["projects.read"],
      services,
    });

    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
    });
    expect(projectsList).not.toHaveBeenCalled();
  });

  it("filters companies.list to the current invocation company", async () => {
    const services = {
      companies: {
        list: vi.fn(async () => [
          { id: "company-a", name: "Company A" },
          { id: "company-b", name: "Company B" },
        ]),
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    await expect(
      handlers["companies.list"](
        {},
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual([{ id: "company-a", name: "Company A" }]);
  });

  it("rejects company-scope store access for a different company", async () => {
    const stateGet = vi.fn(async () => null);
    const services = {
      state: {
        get: stateGet,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["plugin.state.read"],
      services,
    });

    await expect(
      handlers["state.get"](
        { scopeKind: "company", scopeId: "company-b", stateKey: "settings" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(stateGet).not.toHaveBeenCalled();
  });

  it.each([
    [
      "access.members.list",
      "access.members.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.access.listMembers),
    ],
    [
      "access.members.update",
      "access.members.write",
      { companyId: "company-a", memberId: "member-a", patch: { status: "active" } },
      (services: HostServices) => vi.mocked(services.access.updateMember),
    ],
    [
      "authorization.grants.set",
      "authorization.grants.write",
      { companyId: "company-a", principalType: "agent", principalId: "agent-a", grants: [] },
      (services: HostServices) => vi.mocked(services.authorization.setGrants),
    ],
    [
      "authorization.policies.update",
      "authorization.policies.write",
      { companyId: "company-a", resourceType: "agent", resourceId: "agent-a", policy: null },
      (services: HostServices) => vi.mocked(services.authorization.updatePolicy),
    ],
    [
      "authorization.audit.search",
      "authorization.audit.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.authorization.searchAudit),
    ],
  ] as const)(
    "rejects %s when the plugin lacks %s",
    async (method, capability, params, getDelegate) => {
      const services = {
        access: {
          listMembers: vi.fn(async () => []),
          updateMember: vi.fn(async () => ({ id: "member-a" })),
        },
        authorization: {
          setGrants: vi.fn(async () => []),
          updatePolicy: vi.fn(async () => ({ policy: null })),
          searchAudit: vi.fn(async () => []),
        },
      } as unknown as HostServices;
      const handlers = createHostClientHandlers({
        pluginId: "paperclip.test",
        capabilities: [],
        services,
      });

      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toMatchObject({
        name: "CapabilityDeniedError",
        message: expect.stringContaining(capability),
      });
      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
      expect(getDelegate(services)).not.toHaveBeenCalled();
    },
  );

  it("allows a no-invocation-id call when the requested company is an active scope", async () => {
    const issuesGet = vi.fn(async () => ({ id: "issue-1" }));
    const services = {
      issues: { get: issuesGet },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.read"],
      services,
    });

    await expect(
      handlers["issues.get"](
        { companyId: "company-a", issueId: "issue-1" },
        { inferredCompanyScopes: ["company-a"] },
      ),
    ).resolves.toEqual({ id: "issue-1" });
    expect(issuesGet).toHaveBeenCalledTimes(1);
  });

  it("denies a no-invocation-id call for a company outside the active scopes", async () => {
    const issuesGet = vi.fn(async () => ({ id: "issue-1" }));
    const services = {
      issues: { get: issuesGet },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.read"],
      services,
    });

    await expect(
      handlers["issues.get"](
        { companyId: "company-b", issueId: "issue-1" },
        { inferredCompanyScopes: ["company-a"] },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(issuesGet).not.toHaveBeenCalled();
  });

  it("filters companies.list to the active inferred scopes (no invocation id)", async () => {
    const companiesList = vi.fn(async () => [
      { id: "company-a", name: "Company A" },
      { id: "company-b", name: "Company B" },
    ]);
    const services = {
      companies: { list: companiesList },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    // companies.list is a discovery call: with only inferred scopes it is
    // allowed but filtered to those scopes (mirrors the echoed-scope path),
    // so the check-watches job can enumerate its in-flight company.
    await expect(
      handlers["companies.list"]({}, { inferredCompanyScopes: ["company-a"] }),
    ).resolves.toEqual([{ id: "company-a", name: "Company A" }]);
    expect(companiesList).toHaveBeenCalledTimes(1);
  });

  it("allows all-company host calls in PURE system mode (no company scope in flight)", async () => {
    const issuesGet = vi.fn(async () => ({ id: "issue-1" }));
    const services = {
      issues: { get: issuesGet },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.read"],
      services,
    });

    // Pure system/all-company invocation: no company-scoped invocation is also
    // active, so the blanket all-company privilege is granted (e.g. the
    // periodic check-watches job). A cross-company nested call is allowed.
    await expect(
      handlers["issues.get"](
        { companyId: "company-b", issueId: "issue-1" },
        { inferredAllCompanyScope: true },
      ),
    ).resolves.toEqual({ id: "issue-1" });
    expect(issuesGet).toHaveBeenCalledTimes(1);
  });

  it("does NOT bleed all-company privilege in MIXED mode (system + company scope)", async () => {
    // TWX-88 regression: when a system/all-company invocation overlaps a
    // company-scoped invocation, a no-invocation-id worker call must NOT inherit
    // all-company privileges. It is restricted to the inferred company set.
    const issuesGet = vi.fn(async (params: { companyId: string }) => ({
      id: params.companyId,
    }));
    const services = {
      issues: { get: issuesGet },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.read"],
      services,
    });

    // Same-company (company-a) request is allowed.
    await expect(
      handlers["issues.get"](
        { companyId: "company-a", issueId: "issue-1" },
        { inferredAllCompanyScope: true, inferredCompanyScopes: ["company-a"] },
      ),
    ).resolves.toEqual({ id: "company-a" });

    // Cross-company (company-b) request is denied despite the active all-company
    // scope — no privilege bleed.
    await expect(
      handlers["issues.get"](
        { companyId: "company-b", issueId: "issue-1" },
        { inferredAllCompanyScope: true, inferredCompanyScopes: ["company-a"] },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(issuesGet).toHaveBeenCalledTimes(1);
  });

  it("does not filter companies.list in PURE system mode", async () => {
    const companiesList = vi.fn(async () => [
      { id: "company-a", name: "Company A" },
      { id: "company-b", name: "Company B" },
    ]);
    const services = {
      companies: { list: companiesList },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    await expect(
      handlers["companies.list"]({}, { inferredAllCompanyScope: true }),
    ).resolves.toEqual([
      { id: "company-a", name: "Company A" },
      { id: "company-b", name: "Company B" },
    ]);
    expect(companiesList).toHaveBeenCalledTimes(1);
  });

  it("filters companies.list to the inferred set in MIXED mode (no privilege bleed)", async () => {
    // TWX-88 regression: a system invocation overlapping a company-scoped one
    // must not let companies.list enumerate companies outside the inferred set.
    const companiesList = vi.fn(async () => [
      { id: "company-a", name: "Company A" },
      { id: "company-b", name: "Company B" },
    ]);
    const services = {
      companies: { list: companiesList },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    await expect(
      handlers["companies.list"](
        {},
        { inferredAllCompanyScope: true, inferredCompanyScopes: ["company-a"] },
      ),
    ).resolves.toEqual([{ id: "company-a", name: "Company A" }]);
    expect(companiesList).toHaveBeenCalledTimes(1);
  });

  it("still denies a non-companies.list all-company request under inferred scopes", async () => {
    const stateGet = vi.fn(async () => null);
    const services = {
      state: { get: stateGet },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["plugin.state.read"],
      services,
    });

    // scopeKind=company with no scopeId resolves to an all-company request; it
    // cannot be safely served from inferred scopes, so it is denied.
    await expect(
      handlers["state.get"](
        { scopeKind: "company", stateKey: "settings" },
        { inferredCompanyScopes: ["company-a"] },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(stateGet).not.toHaveBeenCalled();
  });

  it("allows an all-company (companies.list) call when no scope is active", async () => {
    const companiesList = vi.fn(async () => [
      { id: "company-a" },
      { id: "company-b" },
    ]);
    const services = {
      companies: { list: companiesList },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    await expect(handlers["companies.list"]({}, {})).resolves.toEqual([
      { id: "company-a" },
      { id: "company-b" },
    ]);
    expect(companiesList).toHaveBeenCalledTimes(1);
  });

  it("checks invocation company scope before exposing authorization data", async () => {
    const searchAudit = vi.fn(async () => []);
    const services = {
      authorization: {
        searchAudit,
      },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["authorization.audit.read"],
      services,
    });

    await expect(
      handlers["authorization.audit.search"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(searchAudit).not.toHaveBeenCalled();
  });
});
