import { describe, expect, it } from "vitest";
import { firstMeaningfulErrorLine, firstNonEmptyLine } from "./utils.js";

// The exact stderr captured from a dead free-tier Gemini OAuth client (TWB-2094):
// the benign YOLO banner is the first line, the real fatal auth error follows.
const YOLO_BANNER_THEN_AUTH_DEATH = [
  "YOLO mode is enabled. All tool calls will be automatically approved.",
  "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. Please upgrade. [UNSUPPORTED_CLIENT]",
].join("\n");

describe("firstNonEmptyLine", () => {
  it("returns the first non-empty trimmed line (legacy behaviour)", () => {
    expect(firstNonEmptyLine("\n\n  hello \nworld")).toBe("hello");
  });
});

describe("firstMeaningfulErrorLine", () => {
  it("surfaces the real auth error, not the leading YOLO banner", () => {
    expect(firstMeaningfulErrorLine(YOLO_BANNER_THEN_AUTH_DEATH)).toMatch(
      /IneligibleTierError/,
    );
    expect(firstMeaningfulErrorLine(YOLO_BANNER_THEN_AUTH_DEATH)).not.toMatch(
      /^YOLO mode is enabled/,
    );
  });

  it("skips the full set of known-benign banner lines", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "Approval mode overridden by --approval-mode.",
      "You are not running in a trusted directory.",
      "Shell cwd was reset to /tmp.",
      "Loaded cached credentials.",
      "Error: something actually broke",
    ].join("\n");
    expect(firstMeaningfulErrorLine(stderr)).toBe("Error: something actually broke");
  });

  it("prefers a stack frame over a leading banner", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "    at ChatService.run (/app/chat.js:42:7)",
    ].join("\n");
    expect(firstMeaningfulErrorLine(stderr)).toMatch(/^at ChatService\.run/);
  });

  it("falls back to the first line when every line is benign", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "Shell cwd was reset to /tmp.",
    ].join("\n");
    expect(firstMeaningfulErrorLine(stderr)).toBe(
      "YOLO mode is enabled. All tool calls will be automatically approved.",
    );
  });

  it("returns an empty string for empty input", () => {
    expect(firstMeaningfulErrorLine("")).toBe("");
  });
});
