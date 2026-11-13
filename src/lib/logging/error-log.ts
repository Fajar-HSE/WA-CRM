import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  cleanMessage,
  cleanStack,
  normalizeForFingerprint,
  sanitizeContext,
  topFrame,
} from './sanitize';

// ============================================================
// logError(): write a problem to the error_logs table (migration 068).
//
// Rules:
//   - It NEVER throws and never blocks the caller for long. A broken
//     log must not break the thing it reports on.
//   - It always also prints to the console, so Vercel logs keep working.
//   - The same problem is stored once and counted (database side);
//     in addition one server instance writes at most MAX_PER_WINDOW
//     reports per fingerprint per minute.
//   - Await it in request handlers: a serverless function may be frozen
//     as soon as the response is sent.
// ============================================================

export type ErrorLevel = 'error' | 'warning';

export interface LogErrorOptions {
  accountId?: string | null;
  level?: ErrorLevel;
  /** Small facts that help to find the problem (ids, counts, status codes). */
  context?: Record<string, unknown>;
}

const WRITE_TIMEOUT_MS = 2500;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;
const MAX_TRACKED = 500;

const recent = new Map<string, { count: number; start: number }>();

/** True when this instance may still write this fingerprint right now. */
export function allowWrite(fingerprint: string, now = Date.now()): boolean {
  const hit = recent.get(fingerprint);
  if (!hit || now - hit.start > WINDOW_MS) {
    if (recent.size >= MAX_TRACKED) recent.clear();
    recent.set(fingerprint, { count: 1, start: now });
    return true;
  }
  hit.count += 1;
  return hit.count <= MAX_PER_WINDOW;
}

export function __resetErrorLogThrottleForTests(): void {
  recent.clear();
}

export function fingerprintFor(source: string, message: string, stack: string | null): string {
  return createHash('sha256')
    .update(`${source}|${normalizeForFingerprint(message)}|${topFrame(stack)}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Record a problem. `source` says where it happened, e.g. 'waha.webhook'.
 * Resolves (never rejects) once the write finished, failed or timed out.
 */
export async function logError(
  source: string,
  err: unknown,
  options: LogErrorOptions = {},
): Promise<void> {
  const level = options.level ?? 'error';
  // Keep the console line: it is what Vercel shows.
  console[level === 'warning' ? 'warn' : 'error'](`[${source}]`, err);

  try {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;

    const message = cleanMessage(err);
    const stack = cleanStack(err);
    const fingerprint = fingerprintFor(source, message, stack);
    if (!allowWrite(fingerprint)) return;

    const write = supabaseAdmin().rpc('record_error_log', {
      p_account_id: options.accountId ?? null,
      p_source: source,
      p_level: level,
      p_message: message,
      p_stack: stack,
      p_context: sanitizeContext(options.context ?? {}),
      p_fingerprint: fingerprint,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), WRITE_TIMEOUT_MS);
    });
    const result = await Promise.race([Promise.resolve(write), timeout]);
    if (timer) clearTimeout(timer);
    if (result !== 'timeout' && result.error) {
      // Not logError() again: that would loop.
      console.error('[error-log] could not store the report:', result.error.message);
    }
  } catch (loggingFailure) {
    console.error('[error-log] could not store the report:', loggingFailure);
  }
}
