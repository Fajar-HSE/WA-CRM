// ============================================================
// Cleaning a problem report before it is stored.
//
// An error log must help the admin find the problem without becoming a
// second copy of the customer data. So before anything is written:
//   - values under secret-looking keys are replaced,
//   - message text / bodies are never kept,
//   - tokens, keys and long digit runs (phone numbers) are masked,
//   - everything is cut to a safe size.
// Pure functions, no I/O, safe in the browser and on the server.
// ============================================================

const SECRET_KEY = /key|token|secret|password|passwd|authorization|cookie|signature|credential|bearer|session/i;
// Content of customer messages and similar free text.
const CONTENT_KEY = /^(text|body|content|caption|message_body|payload|html|prompt)$/i;

const MAX_STRING = 500;
const MAX_DEPTH = 4;
const MAX_ITEMS = 20;
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;

/** Mask things that must never be stored, inside free text. */
export function scrubText(input: string): string {
  return (
    input
      // Authorization headers / bearer tokens
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
      // JWTs
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]')
      // Provider-style keys: sk-..., sk_live_..., AIza..., xoxb-..., ghp_...
      .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g, '[redacted-key]')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted-key]')
      .replace(/\b(?:xox[abprs]|gh[pousr])[-_][A-Za-z0-9_-]{10,}/g, '[redacted-key]')
      // key=value / "key":"value" with a secret-looking name
      .replace(
        /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,}]{4,}/gi,
        '$1[redacted]',
      )
      // Query strings can carry tokens: keep the path only.
      .replace(/(https?:\/\/[^\s?#"')]+)\?[^\s"')]*/g, '$1?[query]')
      // Email addresses
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
      // Phone numbers / long ids: 9 or more digits in a row (optionally +)
      .replace(/\+?\d{9,}/g, '[number]')
  );
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Message of any thrown value, cleaned and shortened. */
export function cleanMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) raw = err.message || err.name;
  else if (typeof err === 'string') raw = err;
  else {
    try {
      raw = JSON.stringify(err) ?? String(err);
    } catch {
      raw = String(err);
    }
  }
  return clip(scrubText(raw), MAX_MESSAGE);
}

/** Stack of an Error, cleaned and shortened. Null when there is none. */
export function cleanStack(err: unknown): string | null {
  if (!(err instanceof Error) || !err.stack) return null;
  return clip(scrubText(err.stack), MAX_STACK);
}

/** Context object cleaned recursively. Always returns a plain object. */
export function sanitizeContext(value: unknown): Record<string, unknown> {
  const out = sanitizeValue(value, 0);
  return out && typeof out === 'object' && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : {};
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clip(scrubText(value), MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return cleanMessage(value);
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((v) => sanitizeValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      if (SECRET_KEY.test(k)) out[k] = '[redacted]';
      else if (CONTENT_KEY.test(k)) out[k] = '[not stored]';
      else out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Text that stays the same between two occurrences of the same problem:
 * digits, uuids and quoted values are flattened so "doc 12 failed" and
 * "doc 98 failed" group together.
 */
export function normalizeForFingerprint(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/"[^"]*"|'[^']*'/g, '?')
    .slice(0, 200);
}

/** First stack frame that points at our code (or any frame). */
export function topFrame(stack: string | null): string {
  if (!stack) return '';
  const lines = stack.split('\n').map((l) => l.trim());
  const frame = lines.find((l) => l.startsWith('at ') && !l.includes('node_modules')) ?? '';
  // Line/column numbers move with every build; the function name is stable.
  return frame.replace(/:\d+:\d+\)?$/, '').slice(0, 160);
}
