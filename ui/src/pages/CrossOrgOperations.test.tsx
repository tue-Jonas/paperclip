// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossOrgOperations } from "./CrossOrgOperations";
import type { ManagementCompanyListResponse, ManagementCompanyDetailResponse } from "@paperclipai/shared";

const listCompaniesMock = vi.hoisted(() => vi.fn());
const getCompanyMock = vi.hoisted(() => vi.fn());
const listCompanyIssuesMock = vi.hoisted(() => vi.fn());
const listCompanyRunsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/management", () => ({
  managementApi: {
    listCompanies: () => listCompaniesMock(),
    getCompany: (id: string) => getCompanyMock(id),
    listCompanyIssues: (id: string, params: unknown) => listCompanyIssuesMock(id, params),
    listCompanyRuns: (id: string, params: unknown) => listCompanyRunsMock(id, params),
  },
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const COMPANY_A: ManagementCompanyListResponse["companies"][0] = {
  id: "company-a",
  name: "Alpha Org",
  description: null,
  status: "active",
  pauseReason: null,
  pausedAt: null,
  issuePrefix: "ALP",
  agentCount: 3,
  activeAgentCount: 2,
  pausedAgentCount: 1,
  projectCount: 1,
  activeProjectCount: 1,
  openIssueCount: 10,
  blockedIssueCount: 2,
  pendingApprovalCount: 0,
  activeRunCount: 1,
  attentionRunCount: 0,
  recoveryActionCount: 0,
  lastRunStartedAt: new Date("2026-06-16T10:00:00Z"),
  updatedAt: new Date("2026-06-16T10:00:00Z"),
};

const DETAIL_A: ManagementCompanyDetailResponse = {
  company: COMPANY_A,
  health: {
    activeRunCount: 1,
    attentionRunCount: 0,
    blockedIssueCount: 2,
    recoveryActionCount: 0,
    pendingApprovalCount: 0,
    pausedAgentCount: 1,
    lastRunStartedAt: new Date("2026-06-16T10:00:00Z"),
  },
  agents: [
    {
      id: "agent-1",
      companyId: "company-a",
      name: "CEO",
      role: "engineer",
      title: "Chief Executive",
      status: "active",
      reportsTo: null,
      lastHeartbeatAt: null,
      updatedAt: new Date("2026-06-16T10:00:00Z"),
    },
  ],
  projects: [
    {
      id: "project-1",
      companyId: "company-a",
      goalId: null,
      name: "Main Project",
      description: null,
      status: "in_progress",
      leadAgentId: null,
      targetDate: null,
      openIssueCount: 10,
      blockedIssueCount: 2,
      updatedAt: new Date("2026-06-16T10:00:00Z"),
    },
  ],
  approvals: [],
};

async function flushReact() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { container, root, queryClient };
}

describe("CrossOrgOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows loading state initially", async () => {
    listCompaniesMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container, root, queryClient } = renderPage();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CrossOrgOperations />
        </QueryClientProvider>,
      );
    });
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    await act(async () => { root.unmount(); });
  });

  it("shows a 403 error message on forbidden response", async () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    listCompaniesMock.mockRejectedValue(err);
    const { container, root, queryClient } = renderPage();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CrossOrgOperations />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    expect(container.textContent).toContain("Forbidden");
    await act(async () => { root.unmount(); });
  });

  it("shows empty state when no companies returned", async () => {
    listCompaniesMock.mockResolvedValue({ companies: [] });
    const { container, root, queryClient } = renderPage();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CrossOrgOperations />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    expect(container.textContent).toContain("No accessible companies");
    await act(async () => { root.unmount(); });
  });

  it("renders health overview rows with company names", async () => {
    listCompaniesMock.mockResolvedValue({ companies: [COMPANY_A] });
    getCompanyMock.mockResolvedValue(DETAIL_A);
    const { container, root, queryClient } = renderPage();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CrossOrgOperations />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Alpha Org");
    expect(container.textContent).toContain("ALP");
    await act(async () => { root.unmount(); });
  });

  it("shows cross-org context banner when a company is selected", async () => {
    listCompaniesMock.mockResolvedValue({ companies: [COMPANY_A] });
    getCompanyMock.mockResolvedValue(DETAIL_A);
    const { container, root, queryClient } = renderPage();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CrossOrgOperations />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("cross-org context");
    await act(async () => { root.unmount(); });
  });

  it("shows health stat tiles for selected company", async () => {
    listCompaniesMock.mockResolvedValue({ companies: [COMPANY_A] });
    getCompanyMock.mockResolvedValue(DETAIL_A);
    const { container, root, queryClient } = renderPage();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CrossOrgOperations />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Blocked issues");
    expect(container.textContent).toContain("Active runs");
    expect(container.textContent).toContain("Main Project");
    await act(async () => { root.unmount(); });
  });

  it("does not render any write controls", async () => {
    listCompaniesMock.mockResolvedValue({ companies: [COMPANY_A] });
    getCompanyMock.mockResolvedValue(DETAIL_A);
    const { container, root, queryClient } = renderPage();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CrossOrgOperations />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    const buttons = Array.from(container.querySelectorAll("button"));
    const editButtons = buttons.filter((b) =>
      /(edit|update|delete|create|save|remove|add|promote|demote|disable|enable)/i.test(b.textContent ?? ""),
    );
    expect(editButtons).toHaveLength(0);
    await act(async () => { root.unmount(); });
  });
});
