import { describe, expect, it } from "vitest";
import {
  createCrossCompanyAgentGrantSchema,
  listCrossCompanyAgentGrantsQuerySchema,
  revokeCrossCompanyAgentGrantSchema,
  updateCompanyMemberWithPermissionsSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";

describe("access validators", () => {
  it("accepts HTTP(S) and Paperclip asset image URLs", () => {
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "https://example.com/avatar.png",
    }).success).toBe(true);
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "/api/assets/avatar/content",
    }).success).toBe(true);
  });

  it("rejects data URI profile images", () => {
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "data:image/png;base64,AAAA",
    }).success).toBe(false);
  });

  it("defaults omitted combined member grants to an empty list", () => {
    const result = updateCompanyMemberWithPermissionsSchema.parse({
      membershipRole: "operator",
    });

    expect(result.grants).toEqual([]);
  });

  it("accepts read-only cross-company agent grant payloads", () => {
    expect(createCrossCompanyAgentGrantSchema.safeParse({
      sourceCompanyId: "11111111-1111-4111-8111-111111111111",
      principalId: "22222222-2222-4222-8222-222222222222",
      targetCompanyId: "33333333-3333-4333-8333-333333333333",
      capability: "read",
    }).success).toBe(true);
    expect(listCrossCompanyAgentGrantsQuerySchema.parse({}).limit).toBe(50);
    expect(revokeCrossCompanyAgentGrantSchema.safeParse({
      grantId: "44444444-4444-4444-8444-444444444444",
    }).success).toBe(true);
  });

  it("rejects same-company cross-company grant payloads", () => {
    expect(createCrossCompanyAgentGrantSchema.safeParse({
      sourceCompanyId: "11111111-1111-4111-8111-111111111111",
      principalId: "22222222-2222-4222-8222-222222222222",
      targetCompanyId: "11111111-1111-4111-8111-111111111111",
      capability: "read",
    }).success).toBe(false);
  });
});
