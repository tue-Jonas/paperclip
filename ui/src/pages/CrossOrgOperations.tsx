import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronRight,
  Clock,
  Layers,
  Play,
  XCircle,
} from "lucide-react";
import type {
  ManagementCompanySummary,
  ManagementIssueSummary,
  ManagementRunSummary,
} from "@paperclipai/shared";
import { managementApi } from "@/api/management";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn, relativeTime } from "@/lib/utils";

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", ok ? "bg-emerald-500" : "bg-amber-500")}
    />
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{children}</div>;
}

function CountChip({ value, variant = "default" }: { value: number; variant?: "default" | "warn" | "error" }) {
  if (value === 0) return <span className="text-xs text-muted-foreground">0</span>;
  const cls =
    variant === "error"
      ? "bg-destructive/15 text-destructive"
      : variant === "warn"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium tabular-nums", cls)}>{value}</span>;
}

function IssueStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    blocked: "bg-destructive/15 text-destructive",
    in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    in_review: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
    todo: "bg-muted text-muted-foreground",
    done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
    cancelled: "bg-muted text-muted-foreground line-through",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        map[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function RunStatusIcon({ status }: { status: string }) {
  if (status === "running" || status === "pending") return <Play className="h-3.5 w-3.5 text-blue-500" aria-label="running" />;
  if (status === "success" || status === "done") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-label="success" />;
  if (status === "error" || status === "failed") return <XCircle className="h-3.5 w-3.5 text-destructive" aria-label="error" />;
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-label={status} />;
}

function LoadingRows({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}

function ErrorDisplay({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      {message}
    </div>
  );
}

function CompanyHealthRow({ company }: { company: ManagementCompanySummary }) {
  const hasAttention =
    company.blockedIssueCount > 0 || company.attentionRunCount > 0 || company.recoveryActionCount > 0;
  return (
    <div className="grid grid-cols-[1fr_repeat(5,auto)] items-center gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <StatusDot ok={!hasAttention} />
          <span className="truncate text-sm font-medium">{company.name}</span>
          <span className="text-xs text-muted-foreground">({company.issuePrefix})</span>
        </div>
        {company.lastRunStartedAt ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            Last run {relativeTime(new Date(company.lastRunStartedAt))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-muted-foreground">Active runs</span>
        <CountChip value={company.activeRunCount} />
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-muted-foreground">Attention</span>
        <CountChip value={company.attentionRunCount} variant={company.attentionRunCount > 0 ? "warn" : "default"} />
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-muted-foreground">Blocked</span>
        <CountChip value={company.blockedIssueCount} variant={company.blockedIssueCount > 0 ? "error" : "default"} />
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-muted-foreground">Recovery</span>
        <CountChip value={company.recoveryActionCount} variant={company.recoveryActionCount > 0 ? "warn" : "default"} />
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-muted-foreground">Approvals</span>
        <CountChip value={company.pendingApprovalCount} variant={company.pendingApprovalCount > 0 ? "warn" : "default"} />
      </div>
    </div>
  );
}

type DetailTab = "overview" | "issues" | "runs";

function CompanyDetail({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [issueStatus, setIssueStatus] = useState<string>("blocked");

  const detailQuery = useQuery({
    queryKey: queryKeys.management.company(companyId),
    queryFn: () => managementApi.getCompany(companyId),
  });

  const issuesQuery = useQuery({
    queryKey: queryKeys.management.companyIssues(companyId, issueStatus === "all" ? undefined : issueStatus),
    queryFn: () =>
      managementApi.listCompanyIssues(companyId, {
        status: issueStatus === "all" ? undefined : issueStatus,
        limit: 50,
      }),
    enabled: tab === "issues",
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.management.companyRuns(companyId, true),
    queryFn: () => managementApi.listCompanyRuns(companyId, { activeOnly: true, limit: 50 }),
    enabled: tab === "runs",
    refetchInterval: 15_000,
  });

  const tabClass = (t: DetailTab) =>
    cn(
      "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
      tab === t
        ? "border-foreground text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950/30">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-amber-800 dark:text-amber-300">
          Viewing cross-org context: <strong>{companyName}</strong>. Read-only.
        </span>
      </div>

      <div className="flex gap-1 border-b border-border">
        <button type="button" className={tabClass("overview")} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button type="button" className={tabClass("issues")} onClick={() => setTab("issues")}>
          Issues / blockers
        </button>
        <button type="button" className={tabClass("runs")} onClick={() => setTab("runs")}>
          Active runs
        </button>
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          {detailQuery.isLoading && <LoadingRows count={3} />}
          {detailQuery.error && (
            <ErrorDisplay
              message={
                detailQuery.error instanceof ApiError
                  ? detailQuery.error.message
                  : "Failed to load company details."
              }
            />
          )}
          {detailQuery.data && (
            <>
              <section className="space-y-2">
                <SectionLabel>Health</SectionLabel>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    { label: "Active runs", value: detailQuery.data.health.activeRunCount },
                    { label: "Attention runs", value: detailQuery.data.health.attentionRunCount, warn: true },
                    { label: "Blocked issues", value: detailQuery.data.health.blockedIssueCount, error: true },
                    { label: "Recovery actions", value: detailQuery.data.health.recoveryActionCount, warn: true },
                    { label: "Pending approvals", value: detailQuery.data.health.pendingApprovalCount, warn: true },
                    { label: "Paused agents", value: detailQuery.data.health.pausedAgentCount },
                  ].map(({ label, value, warn, error }) => (
                    <div key={label} className="rounded-lg border border-border bg-card p-3">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div
                        className={cn(
                          "mt-1 text-2xl font-semibold tabular-nums",
                          error && value > 0
                            ? "text-destructive"
                            : warn && value > 0
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-foreground",
                        )}
                      >
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {detailQuery.data.projects.length > 0 && (
                <section className="space-y-2">
                  <SectionLabel>Projects ({detailQuery.data.projects.length})</SectionLabel>
                  <div className="space-y-2">
                    {detailQuery.data.projects.map((proj) => (
                      <div
                        key={proj.id}
                        className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm font-medium">{proj.name}</span>
                            <Badge variant="outline" className="text-xs">
                              {proj.status}
                            </Badge>
                          </div>
                          {proj.description && (
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">{proj.description}</div>
                          )}
                        </div>
                        <div className="ml-4 flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                          <span>{proj.openIssueCount} open</span>
                          {proj.blockedIssueCount > 0 && (
                            <span className="text-destructive">{proj.blockedIssueCount} blocked</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {detailQuery.data.agents.length > 0 && (
                <section className="space-y-2">
                  <SectionLabel>Agents ({detailQuery.data.agents.length})</SectionLabel>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {detailQuery.data.agents.map((agent) => (
                      <div
                        key={agent.id}
                        className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{agent.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {agent.role}
                            {agent.title ? ` · ${agent.title}` : ""}
                          </div>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            "shrink-0 text-xs",
                            agent.status === "active"
                              ? "border-emerald-400 text-emerald-700 dark:text-emerald-400"
                              : agent.status === "paused"
                                ? "border-amber-400 text-amber-700 dark:text-amber-400"
                                : "",
                          )}
                        >
                          {agent.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {detailQuery.data.approvals.length > 0 && (
                <section className="space-y-2">
                  <SectionLabel>Pending approvals ({detailQuery.data.approvals.length})</SectionLabel>
                  <div className="space-y-2">
                    {detailQuery.data.approvals.map((appr) => (
                      <div
                        key={appr.id}
                        className="rounded-lg border border-border px-3 py-2.5 text-sm"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{appr.type.replace(/_/g, " ")}</span>
                          <Badge variant="outline" className="text-xs">
                            {appr.status}
                          </Badge>
                        </div>
                        {appr.payloadSummary?.title ? (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {String(appr.payloadSummary.title)}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {tab === "issues" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium" htmlFor="issue-status-filter">
              Filter by status
            </label>
            <select
              id="issue-status-filter"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={issueStatus}
              onChange={(e) => setIssueStatus(e.target.value)}
            >
              <option value="blocked">Blocked</option>
              <option value="in_progress">In progress</option>
              <option value="in_review">In review</option>
              <option value="todo">To do</option>
              <option value="all">All</option>
            </select>
          </div>

          {issuesQuery.isLoading && <LoadingRows />}
          {issuesQuery.error && (
            <ErrorDisplay
              message={
                issuesQuery.error instanceof ApiError
                  ? issuesQuery.error.message
                  : "Failed to load issues."
              }
            />
          )}
          {issuesQuery.data?.issues.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No {issueStatus === "all" ? "" : issueStatus.replace(/_/g, " ")} issues found.
            </div>
          )}
          {issuesQuery.data && issuesQuery.data.issues.length > 0 && (
            <div className="space-y-2">
              {issuesQuery.data.issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} />
              ))}
              {issuesQuery.data.nextOffset !== null && (
                <div className="pt-1 text-center text-xs text-muted-foreground">
                  Showing first 50 results
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "runs" && (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">Active runs · refreshes every 15s</div>
          {runsQuery.isLoading && <LoadingRows />}
          {runsQuery.error && (
            <ErrorDisplay
              message={
                runsQuery.error instanceof ApiError
                  ? runsQuery.error.message
                  : "Failed to load runs."
              }
            />
          )}
          {runsQuery.data?.runs.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No active runs.</div>
          )}
          {runsQuery.data && runsQuery.data.runs.length > 0 && (
            <div className="space-y-2">
              {runsQuery.data.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue }: { issue: ManagementIssueSummary }) {
  return (
    <div className="space-y-1 rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="mr-2 text-xs font-mono text-muted-foreground">{issue.identifier ?? "—"}</span>
          <span className="text-sm font-medium">{issue.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IssueStatusBadge status={issue.status} />
        </div>
      </div>
      {issue.projectName && (
        <div className="text-xs text-muted-foreground">{issue.projectName}</div>
      )}
      {issue.activeRecoveryAction && (
        <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          Recovery: {issue.activeRecoveryAction.kind.replace(/_/g, " ")} ·{" "}
          {issue.activeRecoveryAction.status}
        </div>
      )}
      {issue.blockedBy.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {issue.blockedBy.map((blocker) => (
            <span
              key={blocker.id}
              className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive"
            >
              <XCircle className="h-3 w-3 shrink-0" />
              {blocker.identifier ?? blocker.id.slice(0, 8)}: {blocker.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: ManagementRunSummary }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
      <RunStatusIcon status={run.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{run.agentName ?? run.agentId.slice(0, 8)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {run.startedAt ? relativeTime(new Date(run.startedAt)) : "—"}
          </span>
        </div>
        {run.issueTitle && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {run.issueIdentifier ? `${run.issueIdentifier}: ` : ""}
            {run.issueTitle}
          </div>
        )}
        {run.errorCode && (
          <div className="mt-0.5 text-xs text-destructive">{run.errorCode}</div>
        )}
      </div>
    </div>
  );
}

export function CrossOrgOperations() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Cross-org ops" },
    ]);
  }, [setBreadcrumbs]);

  const companiesQuery = useQuery({
    queryKey: queryKeys.management.companies,
    queryFn: () => managementApi.listCompanies(),
  });

  const companies = companiesQuery.data?.companies ?? [];

  useEffect(() => {
    if (!selectedCompanyId && companies.length > 0) {
      setSelectedCompanyId(companies[0]!.id);
    }
  }, [selectedCompanyId, companies]);

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId) ?? null;

  if (companiesQuery.isLoading) {
    return <LoadingRows count={5} />;
  }

  if (companiesQuery.error) {
    const message =
      companiesQuery.error instanceof ApiError && companiesQuery.error.status === 403
        ? "Instance admin or cross-org grant required to view management data."
        : companiesQuery.error instanceof Error
          ? companiesQuery.error.message
          : "Failed to load accessible companies.";
    return <ErrorDisplay message={message} />;
  }

  if (companies.length === 0) {
    return (
      <div className="max-w-xl space-y-4">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Cross-org operations</h1>
        </div>
        <div className="py-8 text-center text-sm text-muted-foreground">
          No accessible companies. Cross-org agent grants or instance-admin access required.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Cross-org operations</h1>
          <Badge variant="secondary" className="text-xs">
            Read-only
          </Badge>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Read-only visibility across accessible orgs. No write controls are exposed here.
        </p>
      </div>

      <section className="space-y-2">
        <SectionLabel>Health overview</SectionLabel>
        <div className="space-y-2">
          {companies.map((company) => (
            <button
              key={company.id}
              type="button"
              onClick={() => setSelectedCompanyId(company.id)}
              className={cn(
                "w-full text-left ring-offset-background transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                company.id === selectedCompanyId && "ring-1 ring-foreground",
              )}
              aria-pressed={company.id === selectedCompanyId}
            >
              <CompanyHealthRow company={company} />
            </button>
          ))}
        </div>
      </section>

      {selectedCompany && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <SectionLabel>
              <span className="flex items-center gap-1">
                <Building2 className="h-3.5 w-3.5" />
                {selectedCompany.name}
              </span>
            </SectionLabel>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{selectedCompany.issuePrefix}</span>
          </div>
          <CompanyDetail companyId={selectedCompany.id} companyName={selectedCompany.name} />
        </section>
      )}
    </div>
  );
}
