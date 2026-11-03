/**
 * 'member'    — joins the inviter's account (shared inbox).
 * 'workspace' — the invitee registers an account of their own.
 */
export type InvitationKind = 'member' | 'workspace';

export interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'agent' | 'viewer';
  kind: InvitationKind;
  expires_at: string;
}

export const PEEK_FAIL_REASONS = [
  'not_found',
  'used',
  'expired',
  'rate_limited',
  'server_error',
] as const;

export type PeekFailReason = (typeof PEEK_FAIL_REASONS)[number];

export interface PeekFail {
  ok: false;
  reason: PeekFailReason;
}

export type PeekResult = PeekOk | PeekFail;

export const RETRYABLE_PEEK_FAIL_REASONS: ReadonlySet<PeekFailReason> = new Set([
  'rate_limited',
  'server_error',
]);

function isPeekFailReason(value: unknown): value is PeekFailReason {
  return (
    typeof value === 'string' &&
    (PEEK_FAIL_REASONS as readonly string[]).includes(value)
  );
}

export function toPeekResult(status: number, body: unknown): PeekResult {
  if (status === 429) return { ok: false, reason: 'rate_limited' };
  if (typeof body === 'object' && body !== null) {
    const payload = body as Record<string, unknown>;
    if (payload.ok === true) {
      // `kind` is absent from a database that has not run migration 062.
      const kind: InvitationKind = payload.kind === 'workspace' ? 'workspace' : 'member';
      return { ...(payload as unknown as PeekOk), kind };
    }
    if (payload.ok === false && isPeekFailReason(payload.reason)) {
      return { ok: false, reason: payload.reason };
    }
  }
  return { ok: false, reason: 'server_error' };
}
