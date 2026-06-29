// Drive-letter absolute paths such as "C:\\workbench" or "C:/workbench".
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

/**
 * True when `value` is an absolute filesystem path. Accepts both POSIX paths
 * (leading "/") and Windows drive-letter paths ("C:\\..." or "C:/..."), matching
 * how the rest of the app treats local workspace paths (see project workspace and
 * new-project dialogs). Callers should trim before checking.
 */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(value);
}
