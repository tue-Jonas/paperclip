import { describe, expect, it } from "vitest";
import { defaultAgentCwdSchema, updateCompanySchema } from "./company.js";

describe("defaultAgentCwdSchema", () => {
  it("accepts POSIX absolute paths", () => {
    expect(defaultAgentCwdSchema.parse("/home/tj/workbench")).toBe("/home/tj/workbench");
  });

  it("accepts Windows drive-letter absolute paths", () => {
    expect(defaultAgentCwdSchema.parse("C:\\workbench")).toBe("C:\\workbench");
    expect(defaultAgentCwdSchema.parse("C:/workbench")).toBe("C:/workbench");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(defaultAgentCwdSchema.parse("  /home/tj/workbench  ")).toBe("/home/tj/workbench");
  });

  it("rejects relative paths", () => {
    expect(defaultAgentCwdSchema.safeParse("workbench").success).toBe(false);
    expect(defaultAgentCwdSchema.safeParse("./workbench").success).toBe(false);
    expect(defaultAgentCwdSchema.safeParse("C:workbench").success).toBe(false);
  });

  // null vs undefined semantics: null clears the default, undefined leaves it unchanged.
  it("accepts null to clear the default", () => {
    expect(defaultAgentCwdSchema.parse(null)).toBeNull();
  });

  it("accepts undefined (field omitted) and leaves it absent", () => {
    expect(defaultAgentCwdSchema.parse(undefined)).toBeUndefined();
  });

  it("distinguishes null from undefined on a partial company update", () => {
    const cleared = updateCompanySchema.parse({ defaultAgentCwd: null });
    expect("defaultAgentCwd" in cleared).toBe(true);
    expect(cleared.defaultAgentCwd).toBeNull();

    const untouched = updateCompanySchema.parse({ name: "Acme" });
    expect("defaultAgentCwd" in untouched).toBe(false);
  });
});
