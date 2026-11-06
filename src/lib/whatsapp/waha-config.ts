// ============================================================
// WAHA connection helpers shared by the session route, the webhook
// route and the provider factory.
//
// Tenancy rule: the session name is NEVER taken from the client. It is
// derived from the caller's account on the server (or pinned with the
// WAHA_SESSION_NAME env var for a single-session WAHA Core install), so
// one account can never read the QR code of, start, or log out another
// account's WhatsApp session.
// ============================================================

import { timingSafeEqual } from 'node:crypto'

/** Header WAHA sends our shared secret in (configured per session). */
export const WAHA_WEBHOOK_SECRET_HEADER = 'x-webhook-secret'

/** WAHA only accepts [A-Za-z0-9_-] in session names. */
const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isValidWahaSessionName(name: string): boolean {
  return SESSION_NAME_RE.test(name)
}

/**
 * Session name for an account.
 *
 * - `WAHA_SESSION_NAME` set → every account resolves to that exact name.
 *   WAHA Core (the free edition) only runs one session called
 *   `default`; set `WAHA_SESSION_NAME=default` there. The unique index
 *   on `whatsapp_config.waha_session_name` (migration 060) then lets
 *   only one account claim it.
 * - otherwise → `wa-crm-<account id without dashes>`, unique per account.
 */
export function wahaSessionNameForAccount(
  accountId: string,
  env: string | undefined = process.env.WAHA_SESSION_NAME,
): string {
  const pinned = env?.trim()
  if (pinned) {
    if (!isValidWahaSessionName(pinned)) {
      throw new Error(
        'WAHA_SESSION_NAME may only contain letters, digits, "-" and "_" (max 64).',
      )
    }
    return pinned
  }
  const compact = accountId.replace(/-/g, '')
  const name = `wa-crm-${compact}`
  if (!isValidWahaSessionName(name)) {
    throw new Error('Cannot derive a WAHA session name from this account id.')
  }
  return name
}

/**
 * `whatsapp_config.phone_number_id` is NOT NULL and UNIQUE (Meta
 * legacy). A WAHA row has no Meta phone id, so it stores this stable
 * placeholder instead.
 */
export function wahaPlaceholderPhoneId(sessionName: string): string {
  return `waha:${sessionName}`
}

/** Constant-time comparison of the presented webhook secret. */
export function wahaSecretMatches(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Where WAHA should POST inbound events. `WAHA_WEBHOOK_URL` wins — it
 * is the address of this app as seen FROM the WAHA container, which in
 * Docker is usually an internal name (http://app:3000/...), not the
 * public hostname. Falls back to NEXT_PUBLIC_SITE_URL, then to the
 * origin of the current request.
 */
export function resolveWahaWebhookUrl(requestOrigin: string): string {
  const explicit = process.env.WAHA_WEBHOOK_URL?.trim()
  if (explicit) return explicit
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  return `${site || requestOrigin.replace(/\/+$/, '')}/api/whatsapp/waha/webhook`
}

/** Map a WAHA session status onto the `whatsapp_config.status` check. */
export function wahaStatusToConfigStatus(
  status: string,
): 'connected' | 'disconnected' {
  return status === 'WORKING' ? 'connected' : 'disconnected'
}
