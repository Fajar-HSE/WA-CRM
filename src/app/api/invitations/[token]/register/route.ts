// ============================================================
// POST /api/invitations/[token]/register
//
// Public. THE ONLY way to create a login. Public sign-up is closed
// (turn off "Allow new users to sign up" in Supabase, see
// docs/invite-only.md), so a person can register only by presenting a
// valid, unused invitation token.
//
//   kind 'workspace' — the token is single-use: it is claimed atomically
//     (one UPDATE ... WHERE accepted_at IS NULL) before the user is
//     created, then released again if anything fails. The new account is
//     allowed to connect WhatsApp (accounts.can_connect_whatsapp).
//   kind 'member'    — the token is only checked here; the usual
//     /redeem step moves the new user into the inviter's account and
//     consumes it.
//
// The user is created with the service role (email already confirmed: the
// private link is the proof), then the browser signs in with the password.
// ============================================================

import { NextResponse } from 'next/server'

import { hashInviteToken } from '@/lib/auth/invitations'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  checkRateLimit,
  getClientIp,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const MIN_PASSWORD = 8
const MAX_PASSWORD = 72
const MAX_NAME = 80
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface RegisterBody {
  fullName?: unknown
  email?: unknown
  password?: unknown
}

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const limit = checkRateLimit(
    `register:${getClientIp(request)}`,
    RATE_LIMITS.invitationRedeem,
  )
  if (!limit.success) return rateLimitResponse(limit)

  const { token } = await params
  if (!token || typeof token !== 'string') {
    return fail(t('invitations.missingToken'), 400)
  }

  const body = (await request.json().catch(() => null)) as RegisterBody | null
  const fullName = typeof body?.fullName === 'string' ? body.fullName.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!fullName || fullName.length > MAX_NAME) {
    return fail(t('invitations.nameInvalid', { max: MAX_NAME }), 400)
  }
  if (!EMAIL_RE.test(email)) return fail(t('invitations.emailInvalid'), 400)
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return fail(t('invitations.passwordInvalid', { min: MIN_PASSWORD, max: MAX_PASSWORD }), 400)
  }

  const db = supabaseAdmin()
  const nowIso = new Date().toISOString()

  const { data: invitation, error: lookupError } = await db
    .from('account_invitations')
    .select('id, account_id, kind, accepted_at, expires_at')
    .eq('token_hash', hashInviteToken(token))
    .maybeSingle()
  if (lookupError) {
    console.error('[register] invitation lookup failed:', lookupError.message)
    return fail(t('invitations.registerFailed'), 500)
  }
  if (
    !invitation ||
    invitation.accepted_at !== null ||
    new Date(invitation.expires_at as string).getTime() <= Date.now()
  ) {
    return fail(t('invitations.registerInvalid'), 400)
  }

  const isWorkspace = invitation.kind === 'workspace'

  // The account that issued a workspace invitation must still be allowed to
  // create accounts. This also retires any such invitation an ordinary
  // account created before only the platform account could.
  if (isWorkspace) {
    const { data: inviter } = await db
      .from('accounts')
      .select('can_create_workspaces')
      .eq('id', invitation.account_id)
      .maybeSingle()
    if (inviter?.can_create_workspaces !== true) {
      return fail(t('invitations.registerInvalid'), 400)
    }
  }

  // Single use: claim it before creating anything. Two people racing with
  // the same link cannot both get past this UPDATE.
  if (isWorkspace) {
    const { data: claimed, error: claimError } = await db
      .from('account_invitations')
      .update({ accepted_at: nowIso })
      .eq('id', invitation.id)
      .is('accepted_at', null)
      .gt('expires_at', nowIso)
      .select('id')
    if (claimError || !claimed || claimed.length === 0) {
      if (claimError) console.error('[register] claim failed:', claimError.message)
      return fail(t('invitations.registerInvalid'), 400)
    }
  }

  const release = async () => {
    if (!isWorkspace) return
    await db
      .from('account_invitations')
      .update({ accepted_at: null })
      .eq('id', invitation.id)
      .is('accepted_by_user_id', null)
  }

  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (createError || !created?.user) {
    await release()
    const already = /already|registered|exists/i.test(createError?.message ?? '')
    if (!already) console.error('[register] createUser failed:', createError?.message)
    return fail(
      already ? t('invitations.emailTaken') : t('invitations.registerFailed'),
      already ? 409 : 500,
    )
  }

  const userId = created.user.id

  // The database trigger gives every new login a personal account.
  const { data: profile } = await db
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  const accountId = (profile?.account_id as string | undefined) ?? null

  const rollback = async () => {
    // accounts.owner_user_id is ON DELETE RESTRICT, so the account must go
    // before the user can.
    if (accountId) await db.from('accounts').delete().eq('id', accountId)
    await db.auth.admin.deleteUser(userId)
    await release()
  }

  if (!accountId) {
    console.error('[register] no profile/account was created for', userId)
    await rollback()
    return fail(t('invitations.registerFailed'), 500)
  }

  if (isWorkspace) {
    const { error: grantError } = await db
      .from('accounts')
      .update({ can_connect_whatsapp: true })
      .eq('id', accountId)
    const { error: stampError } = await db
      .from('account_invitations')
      .update({ accepted_by_user_id: userId })
      .eq('id', invitation.id)
    if (grantError || stampError) {
      console.error('[register] grant failed:', grantError?.message ?? stampError?.message)
      await rollback()
      return fail(t('invitations.registerFailed'), 500)
    }
  }

  return NextResponse.json({ ok: true, kind: isWorkspace ? 'workspace' : 'member' })
}
