import { describe, expect, it } from "vitest";
import { isAbsolutePath } from "./absolute-path.js";

describe("isAbsolutePath", () => {
  it("accepts POSIX absolute paths", () => {
    expect(isAbsolutePath("/home/tj/workbench")).toBe(true);
    expect(isAbsolutePath("/")).toBe(true);
  });

  it("accepts Windows drive-letter absolute paths", () => {
    expect(isAbsolutePath("C:\\workbench")).toBe(true);
    expect(isAbsolutePath("C:/workbench")).toBe(true);
    expect(isAbsolutePath("d:\\Users\\agent")).toBe(true);
  });

  it("rejects relative and drive-letter-without-separator paths", () => {
    expect(isAbsolutePath("workbench")).toBe(false);
    expect(isAbsolutePath("./workbench")).toBe(false);
    expect(isAbsolutePath("../workbench")).toBe(false);
    expect(isAbsolutePath("C:workbench")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});
