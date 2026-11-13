// Browser side of the error log: send a crash to /api/error-logs.
// Best effort, never throws, and bounded so a page stuck in a loop cannot
// flood the server (the server also rate-limits and groups repeats).

const MAX_REPORTS_PER_PAGE_LOAD = 5;
const IGNORED = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /AbortError/i,
  /Non-Error promise rejection/i,
  /chrome-extension:|moz-extension:|safari-extension:/i,
];

let sent = 0;
const seen = new Set<string>();

export function shouldReport(message: string, stack?: string | null): boolean {
  if (!message) return false;
  const haystack = `${message}\n${stack ?? ''}`;
  return !IGNORED.some((re) => re.test(haystack));
}

export function reportClientError(
  error: unknown,
  extra: { kind?: string; digest?: string } = {},
): void {
  try {
    if (typeof window === 'undefined') return;
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    if (!shouldReport(message, stack)) return;

    const key = `${extra.kind ?? 'error'}|${message}`;
    if (seen.has(key) || sent >= MAX_REPORTS_PER_PAGE_LOAD) return;
    seen.add(key);
    sent += 1;

    void fetch('/api/error-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        message,
        stack,
        url: window.location.pathname,
        kind: extra.kind ?? 'error',
        digest: extra.digest,
      }),
    }).catch(() => {});
  } catch {
    // Reporting must never cause a second error.
  }
}
