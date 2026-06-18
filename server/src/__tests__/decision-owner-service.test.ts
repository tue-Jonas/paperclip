import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companyMemberships,
  companies,
  createDb,
  goals,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveDecisionOwnerUserId } from "../services/decision-owner.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("decision owner resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-owner-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companyMemberships);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueTree() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Decision routing",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      goalId,
      title: "Root human issue",
      status: "in_progress",
      priority: "medium",
      createdByUserId: "jonas-user",
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      goalId,
      parentId: rootIssueId,
      title: "Agent child issue",
      status: "in_progress",
      priority: "medium",
    });

    return { companyId, rootIssueId, childIssueId };
  }

  async function seedActiveCompanyUser(companyId: string, userId: string, membershipRole = "owner") {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
    });
  }

  it("prefers explicit user, then the initiator (root human requester) over an incidental comment author", async () => {
    const { companyId, childIssueId } = await seedIssueTree();
    const sourceCommentId = randomUUID();
    await seedActiveCompanyUser(companyId, "explicit-user");
    await seedActiveCompanyUser(companyId, "thomas-user");
    await seedActiveCompanyUser(companyId, "jonas-user");
    // A non-initiator (thomas) comments on an issue that jonas initiated.
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId,
      issueId: childIssueId,
      authorUserId: "thomas-user",
      body: "Please ask me.",
    });

    // Explicit targeting always wins (deliberate hand-off / "send it back to X").
    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      explicitUserId: "explicit-user",
      sourceCommentId,
      issueIds: [childIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "explicit-user",
      source: "explicit_user",
    });

    // No explicit target: the decision follows the INITIATOR (jonas, the rootmost
    // human creator), NOT the comment author (thomas) or the current board actor.
    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      sourceCommentId,
      issueIds: [childIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "jonas-user",
      source: "root_human_requester",
    });
  });

  it("falls back to the comment author only when there is no human initiator in the chain", async () => {
    const { companyId } = await seedIssueTree();
    const automatedIssueId = randomUUID();
    const sourceCommentId = randomUUID();
    await seedActiveCompanyUser(companyId, "thomas-user");
    // Routine/automated issue: no human creator anywhere in its chain.
    await db.insert(issues).values({
      id: automatedIssueId,
      companyId,
      title: "Automated routine issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId,
      issueId: automatedIssueId,
      authorUserId: "thomas-user",
      body: "I will take this.",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      sourceCommentId,
      issueIds: [automatedIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "thomas-user",
      source: "source_comment_author",
    });
  });

  it("routes automated work with no human initiator to the configured default owner", async () => {
    const { companyId } = await seedIssueTree();
    const automatedIssueId = randomUUID();
    await seedActiveCompanyUser(companyId, "jonas-user");
    await db.insert(issues).values({
      id: automatedIssueId,
      companyId,
      title: "Automated routine issue",
      status: "in_progress",
      priority: "medium",
    });
    await instanceSettingsService(db).updateGeneral({
      defaultDecisionOwnerUserId: "jonas-user",
    });

    // No initiator, no comment, no current actor -> configured default (jonas).
    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      issueIds: [automatedIssueId],
    })).resolves.toMatchObject({
      userId: "jonas-user",
      source: "configured_default_board_owner",
    });
  });

  it("falls back to current board actor and configured default owner", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "current-user",
      source: "current_board_actor",
    });

    await seedActiveCompanyUser(companyId, "default-user");
    await instanceSettingsService(db).updateGeneral({
      defaultDecisionOwnerUserId: "default-user",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
    })).resolves.toMatchObject({
      userId: "default-user",
      source: "configured_default_board_owner",
    });
  });

  it("rejects explicit users that are not active company members", async () => {
    const { companyId, childIssueId } = await seedIssueTree();

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      explicitUserId: "outsider-user",
      issueIds: [childIssueId],
      currentUserId: "current-user",
    })).rejects.toMatchObject({
      status: 400,
      message: "Explicit decision owner must be an active user in this company",
    });
  });
});
