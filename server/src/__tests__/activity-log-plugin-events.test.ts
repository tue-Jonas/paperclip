import { beforeEach, describe, expect, it, vi } from "vitest";

const publishLiveEventMock = vi.hoisted(() => vi.fn());
const getGeneralMock = vi.hoisted(() => vi.fn(async () => ({ censorUsernameInLogs: false })));
const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: getGeneralMock }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: loggerWarnMock },
}));

import { logActivity, setPluginEventBus } from "../services/activity-log.js";

function createDbStub() {
  return {
    insert: () => ({
      values: async () => undefined,
    }),
  };
}

describe("activity log plugin event mappings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["issue_thread_interaction_created", "issue.interaction.created"],
    ["issue_thread_interaction_accepted", "issue.interaction.accepted"],
    ["issue_thread_interaction_rejected", "issue.interaction.rejected"],
    ["issue_thread_interaction_answered", "issue.interaction.answered"],
    ["issue_thread_interaction_cancelled", "issue.interaction.cancelled"],
    ["issue_thread_interaction_expired", "issue.interaction.expired"],
  ])("maps %s to plugin event %s", async (action, expectedEventType) => {
    const emitMock = vi.fn(async () => ({ errors: [] }));
    setPluginEventBus({ emit: emitMock } as any);

    await logActivity(createDbStub() as any, {
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action,
      entityType: "issue",
      entityId: "issue-1",
      details: { interactionId: "int-1" },
    });

    await vi.waitFor(() => {
      expect(emitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: expectedEventType,
          companyId: "company-1",
          entityId: "issue-1",
          entityType: "issue",
          payload: expect.objectContaining({
            interactionId: "int-1",
          }),
        }),
      );
    });
  });
});
