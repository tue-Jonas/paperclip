import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships, issueComments, issues } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";

const MAX_ISSUE_PARENT_WALK_DEPTH = 50;

type IssueOwnerRow = {
  id: string;
  companyId: string;
  parentId: string | null;
  createdByUserId: string | null;
};

export type DecisionOwnerResolutionSource =
  | "explicit_user"
  | "source_comment_author"
  | "root_human_requester"
  | "current_board_actor"
  | "configured_default_board_owner"
  | "none";

export interface DecisionOwnerResolution {
  userId: string | null;
  source: DecisionOwnerResolutionSource;
  issueId?: string | null;
  commentId?: string | null;
}

function normalizeUserId(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

async function findSourceCommentAuthor(db: Db, args: {
  companyId: string;
  sourceCommentId: string | null | undefined;
}): Promise<DecisionOwnerResolution | null> {
  if (!args.sourceCommentId) return null;
  const comment = await db
    .select({
      id: issueComments.id,
      authorUserId: issueComments.authorUserId,
    })
    .from(issueComments)
    .where(and(eq(issueComments.id, args.sourceCommentId), eq(issueComments.companyId, args.companyId)))
    .then((rows) => rows[0] ?? null);
  const userId = comment ? normalizeUserId(comment.authorUserId) : null;
  return userId
    ? { userId, source: "source_comment_author", commentId: comment!.id }
    : null;
}

async function assertActiveCompanyUser(db: Db, args: {
  companyId: string;
  userId: string;
}) {
  const membership = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, args.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, args.userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (!membership) {
    throw badRequest("Explicit decision owner must be an active user in this company");
  }
}

async function findRootHumanRequesterForIssue(db: Db, args: {
  companyId: string;
  issueId: string;
}): Promise<DecisionOwnerResolution | null> {
  const path: IssueOwnerRow[] = [];
  let cursor: string | null = args.issueId;
  const seen = new Set<string>();

  while (cursor && !seen.has(cursor) && path.length < MAX_ISSUE_PARENT_WALK_DEPTH) {
    seen.add(cursor);
    const row: IssueOwnerRow | null = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        parentId: issues.parentId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, args.companyId), eq(issues.id, cursor)))
      .then((rows) => rows[0] ?? null);
    if (!row) break;
    path.push(row);
    cursor = row.parentId;
  }

  const rootmostHumanIssue = [...path]
    .reverse()
    .find((issue) => normalizeUserId(issue.createdByUserId));
  const userId = normalizeUserId(rootmostHumanIssue?.createdByUserId ?? null);
  return userId
    ? { userId, source: "root_human_requester", issueId: rootmostHumanIssue!.id }
    : null;
}

async function findRootHumanRequester(db: Db, args: {
  companyId: string;
  issueIds?: string[];
}): Promise<DecisionOwnerResolution | null> {
  const issueIds = Array.from(new Set((args.issueIds ?? []).filter(Boolean)));
  for (const issueId of issueIds) {
    const resolution = await findRootHumanRequesterForIssue(db, {
      companyId: args.companyId,
      issueId,
    });
    if (resolution) return resolution;
  }
  return null;
}

async function findConfiguredDefaultOwner(db: Db): Promise<DecisionOwnerResolution | null> {
  const settings = await instanceSettingsService(db).getGeneral();
  const configured = normalizeUserId(settings.defaultDecisionOwnerUserId)
    ?? normalizeUserId(process.env.PAPERCLIP_DEFAULT_DECISION_OWNER_USER_ID)
    ?? normalizeUserId(process.env.PAPERCLIP_DEFAULT_BOARD_USER_ID);
  return configured
    ? { userId: configured, source: "configured_default_board_owner" }
    : null;
}

export async function resolveDecisionOwnerUserId(db: Db, args: {
  companyId: string;
  explicitUserId?: string | null;
  sourceCommentId?: string | null;
  issueIds?: string[];
  currentUserId?: string | null;
}): Promise<DecisionOwnerResolution> {
  const explicitUserId = normalizeUserId(args.explicitUserId);
  if (explicitUserId) {
    await assertActiveCompanyUser(db, {
      companyId: args.companyId,
      userId: explicitUserId,
    });
    return { userId: explicitUserId, source: "explicit_user" };
  }

  // The initiator owns the decision. Resolve the rootmost human requester in
  // the issue's parent chain FIRST, so a decision/approval always follows whoever
  // started the work (e.g. Thomas) rather than an incidental signal like someone
  // else commenting on the thread or the board actor who happened to create the
  // interaction. Explicit targeting (handled above) still wins for deliberate
  // hand-offs like "send it back to me".
  const rootHumanRequester = await findRootHumanRequester(db, {
    companyId: args.companyId,
    issueIds: args.issueIds,
  });
  if (rootHumanRequester) return rootHumanRequester;

  // No human initiator anywhere in the chain (routines / automated work): fall
  // back to weaker signals before the configured default owner.
  const sourceCommentAuthor = await findSourceCommentAuthor(db, {
    companyId: args.companyId,
    sourceCommentId: args.sourceCommentId,
  });
  if (sourceCommentAuthor) return sourceCommentAuthor;

  const currentUserId = normalizeUserId(args.currentUserId);
  if (currentUserId) {
    return { userId: currentUserId, source: "current_board_actor" };
  }

  // Routine / automated work with no human initiator routes to the configured
  // default decision owner (instance-wide), never to "none".
  return await findConfiguredDefaultOwner(db)
    ?? { userId: null, source: "none" };
}

export type ExternalInitiatorResolutionSource =
  | "payload_user_id"
  | "configured_external_map"
  | "member_email_match"
  | "member_name_match";

export interface ExternalInitiatorResolution {
  userId: string;
  source: ExternalInitiatorResolutionSource;
  matchedOn: string;
}

type ActiveCompanyUser = { userId: string; name: string | null; email: string | null };

async function loadActiveCompanyUsers(db: Db, companyId: string): Promise<ActiveCompanyUser[]> {
  return db
    .select({
      userId: companyMemberships.principalId,
      name: authUsers.name,
      email: authUsers.email,
    })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );
}

function readPayloadString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

/**
 * Resolve which Paperclip board user *initiated* externally-triggered work
 * (webhook / API routine fires, e.g. the "Jira intake" routine). The decision
 * routing engine then attributes downstream decisions to that human via the
 * issue's `createdByUserId` (root human requester). Resolution order:
 *   1. explicit Paperclip board user id in the payload
 *   2. configured `externalInitiatorUserMap` (Jira display name / email / accountId -> userId)
 *   3. exact email match against an active company member
 *   4. unambiguous display-name match against an active company member
 * Returns null when no human initiator can be resolved (caller leaves the work
 * with no initiator, so it routes to the configured default decision owner).
 */
export async function resolveExternalInitiatorUserId(db: Db, args: {
  companyId: string;
  payload: unknown;
}): Promise<ExternalInitiatorResolution | null> {
  const payload =
    args.payload && typeof args.payload === "object" && !Array.isArray(args.payload)
      ? (args.payload as Record<string, unknown>)
      : {};

  const explicitUserId = readPayloadString(payload, ["initiatorUserId", "paperclipUserId"]);
  const accountId = readPayloadString(payload, ["assigneeAccountId", "initiatorAccountId", "accountId"]);
  const emailCandidates: string[] = [];
  const directEmail = readPayloadString(payload, ["assigneeEmail", "initiatorEmail", "email"]);
  if (directEmail) emailCandidates.push(directEmail);
  const nameCandidates: string[] = [];
  const assignee = readPayloadString(payload, ["assignee", "initiator", "initiatorName", "assigneeName"]);
  if (assignee) {
    if (assignee.includes("@")) emailCandidates.push(assignee);
    else nameCandidates.push(assignee);
  }

  const members = await loadActiveCompanyUsers(db, args.companyId);
  const activeUserIds = new Set(members.map((m) => m.userId));

  // 1. Explicit board user id.
  if (explicitUserId && activeUserIds.has(explicitUserId)) {
    return { userId: explicitUserId, source: "payload_user_id", matchedOn: explicitUserId };
  }

  // 2. Configured external identity map (case-insensitive keys).
  const { externalInitiatorUserMap } = await instanceSettingsService(db).getGeneral();
  if (externalInitiatorUserMap) {
    const lowered = new Map(
      Object.entries(externalInitiatorUserMap).map(([k, v]) => [k.trim().toLowerCase(), v]),
    );
    const keys = [explicitUserId, accountId, ...emailCandidates, ...nameCandidates].filter(
      (v): v is string => Boolean(v),
    );
    for (const key of keys) {
      const mapped = normalizeUserId(lowered.get(key.trim().toLowerCase()));
      if (mapped && activeUserIds.has(mapped)) {
        return { userId: mapped, source: "configured_external_map", matchedOn: key };
      }
    }
  }

  // 3. Email match against active members.
  for (const email of emailCandidates) {
    const lower = email.trim().toLowerCase();
    const match = members.find((m) => m.email && m.email.trim().toLowerCase() === lower);
    if (match) return { userId: match.userId, source: "member_email_match", matchedOn: email };
  }

  // 4. Unambiguous display-name match against active members.
  for (const name of nameCandidates) {
    const lower = name.trim().toLowerCase();
    const matches = members.filter((m) => m.name && m.name.trim().toLowerCase() === lower);
    if (matches.length === 1) {
      return { userId: matches[0].userId, source: "member_name_match", matchedOn: name };
    }
  }

  return null;
}

export async function loadIssueIdentifiers(db: Db, companyId: string, issueIds: string[]) {
  const uniqueIssueIds = Array.from(new Set(issueIds));
  if (uniqueIssueIds.length === 0) return [];
  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, uniqueIssueIds)));
}
