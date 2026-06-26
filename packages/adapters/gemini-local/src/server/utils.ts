export function firstNonEmptyLine(text: string): string {
    return (
        text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? ""
    );
}

// Benign banner / informational lines the Gemini CLI prints to stderr even on a
// successful-but-then-fatal run. When the real failure follows one of these, the
// naive `firstNonEmptyLine` would surface the banner (e.g. "YOLO mode is enabled")
// as the operator-facing errorMessage and hide the actual death (the WAA QA strand
// was misdiagnosed three times because of this — TWB-2094).
const GEMINI_BENIGN_STDERR_LINE_RE =
    /^(?:YOLO mode is enabled|Approval mode overridden|.*not running in a trusted directory|Shell cwd was reset|Loaded cached credentials)/i;

// Lines that almost certainly carry the real fatal error — prefer these over
// anything else, regardless of position, so a trailing auth death wins over a
// leading banner.
const GEMINI_REAL_ERROR_LINE_RE =
    /(?:Error authenticating|IneligibleTierError|UNSUPPORTED_CLIENT|FatalAuthenticationError|no longer supported for Gemini Code Assist|^\s*at\s+\S|Error:)/i;

/**
 * Pick the most diagnostically useful line from a Gemini CLI stderr blob.
 *
 * Strategy (defensive against the YOLO-banner footgun):
 *   1. Prefer a line that looks like the real fatal error.
 *   2. Otherwise return the first line that is NOT a known-benign banner.
 *   3. Fall back to the first non-empty line (legacy behaviour) when every line
 *      is benign.
 */
export function firstMeaningfulErrorLine(text: string): string {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const realError = lines.find((line) => GEMINI_REAL_ERROR_LINE_RE.test(line));
    if (realError) return realError;

    const nonBenign = lines.find((line) => !GEMINI_BENIGN_STDERR_LINE_RE.test(line));
    if (nonBenign) return nonBenign;

    return lines[0] ?? "";
}
