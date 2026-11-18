import { AiError, type AiUsage, type ChatMessage } from '../types'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
  /** Custom OpenAI-compatible base URL; omitted for native providers. */
  baseUrl?: string | null
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError(t('ai.timeout'), {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(t('ai.unreachable', { message: msg }), {
    code: 'network_error',
    status: 502,
  })
}

const SNIPPET_MAX = 120

/** The visible text of an error body that is not JSON (an HTML block page,
 *  plain text), shortened so it fits in a toast. */
function bodySnippet(raw: string): string {
  const text = raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text
}

/** The provider's own message from a JSON error body, in the shapes seen in
 *  the wild: `{error:{message}}`, `{error:"…"}`, `{message}`, `{detail}`. */
function jsonDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const b = body as { error?: unknown; message?: unknown; detail?: unknown }
  if (typeof b.error === 'string') return b.error
  if (b.error && typeof b.error === 'object') {
    const m = (b.error as { message?: unknown }).message
    if (typeof m === 'string' && m) return m
  }
  if (typeof b.message === 'string') return b.message
  if (typeof b.detail === 'string') return b.detail
  return ''
}

/** Build a typed AiError from a non-2xx provider response. The message says
 *  what the provider said: its own JSON message when there is one, otherwise
 *  a short piece of the body, so a block page from a proxy in front of the
 *  provider is told apart from a real "wrong key" answer. A rejected key also
 *  carries the HTTP status (401 vs 403). */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let raw = ''
  try {
    raw = await res.text()
  } catch {
    // Body unreadable — fall back to the status line.
  }
  let detail = ''
  try {
    detail = jsonDetail(JSON.parse(raw))
  } catch {
    // Not JSON — use a snippet of the body below.
  }
  if (!detail) detail = bodySnippet(raw)

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'invalid_key'
      ? `${t('ai.invalidKey', { provider })} (HTTP ${status})`
      : code === 'rate_limited'
        ? t('ai.rateLimited', { provider })
        : t('ai.apiError', { provider, status: String(status) })

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
