import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import { WahaHttpError, WahaWhatsAppProvider } from '@/lib/whatsapp/providers/waha'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getT } from '@/lib/i18n/translate'
import {
  resolveWahaWebhookUrl,
  wahaPlaceholderPhoneId,
  wahaSessionNameForAccount,
  wahaStatusToConfigStatus,
} from '@/lib/whatsapp/waha-config'

/**
 * WAHA session control for the caller's own account.
 *
 * The session name is never read from the request: it is derived from
 * `ctx.accountId` on the server (see waha-config.ts). That is what keeps
 * one account from reading another account's pairing QR code, starting
 * its session, or logging it out.
 *
 * Creating a session is further limited to accounts that arrived through an
 * invitation (accounts.can_connect_whatsapp, set only by the server). The
 * writes below use the service role: the database refuses the WAHA columns to
 * a browser session (migration 062), so a user cannot attach to a session by
 * editing their own whatsapp_config row.
 */

const t = getT('Api')

const SESSION_UNAVAILABLE = 'NOT_FOUND'

interface WahaConfigRow {
  id: string
  provider: string | null
  waha_session_name: string | null
}

function wahaEnv(): { baseUrl: string; apiKey: string } | { error: string } {
  const baseUrl = process.env.WAHA_BASE_URL?.trim()
  const apiKey = process.env.WAHA_API_KEY?.trim()
  if (!baseUrl) return { error: 'WAHA_BASE_URL is not set on the server.' }
  if (!apiKey) return { error: 'WAHA_API_KEY is not set on the server.' }
  return { baseUrl, apiKey }
}

function providerFor(sessionName: string): WahaWhatsAppProvider | { error: string } {
  const env = wahaEnv()
  if ('error' in env) return env
  return new WahaWhatsAppProvider({ sessionName, ...env })
}

async function loadCanConnect(ctx: AccountContext): Promise<boolean> {
  const { data } = await ctx.supabase
    .from('accounts')
    .select('can_connect_whatsapp')
    .eq('id', ctx.accountId)
    .maybeSingle()
  return data?.can_connect_whatsapp === true
}

async function loadConfig(ctx: AccountContext): Promise<WahaConfigRow | null> {
  const { data, error } = await ctx.supabase
    .from('whatsapp_config')
    .select('id, provider, waha_session_name')
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as WahaConfigRow | null) ?? null
}

/**
 * Make sure this account has a WAHA-backed `whatsapp_config` row. An
 * existing row is switched to WAHA without touching its other columns;
 * a missing one is created with placeholders for the Meta-era NOT NULL
 * columns.
 */
async function ensureWahaRow(
  ctx: AccountContext,
  sessionName: string,
  existing: WahaConfigRow | null,
): Promise<void> {
  if (existing) {
    if (existing.provider === 'waha' && existing.waha_session_name === sessionName) return
    const { error } = await supabaseAdmin()
      .from('whatsapp_config')
      .update({ provider: 'waha', waha_session_name: sessionName })
      .eq('id', existing.id)
      .eq('account_id', ctx.accountId)
    if (error) throw new Error(describeDbError(error))
    return
  }
  const { error } = await supabaseAdmin().from('whatsapp_config').insert({
    account_id: ctx.accountId,
    user_id: ctx.userId,
    provider: 'waha',
    waha_session_name: sessionName,
    phone_number_id: wahaPlaceholderPhoneId(sessionName),
    access_token: '',
    status: 'disconnected',
  })
  if (error) throw new Error(describeDbError(error))
}

function describeDbError(error: { code?: string; message: string }): string {
  // 23505 = unique_violation on whatsapp_config_waha_session_name_unique
  // (or on phone_number_id): another account already holds this session.
  if (error.code === '23505') {
    return 'This WAHA session is already linked to another account.'
  }
  return error.message
}

async function syncStatus(ctx: AccountContext, status: string): Promise<void> {
  await supabaseAdmin()
    .from('whatsapp_config')
    .update({
      waha_session_status: status,
      status: wahaStatusToConfigStatus(status),
    })
    .eq('account_id', ctx.accountId)
}

async function readState(
  ctx: AccountContext,
  provider: WahaWhatsAppProvider,
  webhookUrl: string,
  canConnect: boolean,
) {
  let status = SESSION_UNAVAILABLE
  try {
    status = await provider.getSessionStatus(provider.sessionName)
  } catch (err) {
    if (!(err instanceof WahaHttpError && err.status === 404)) throw err
  }
  const qr =
    status === 'SCAN_QR_CODE' ? await provider.getQrCode(provider.sessionName) : null
  if (status !== SESSION_UNAVAILABLE) await syncStatus(ctx, status)
  return { configured: true, sessionName: provider.sessionName, status, qr, webhookUrl, canConnect }
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const sessionName = wahaSessionNameForAccount(ctx.accountId)
    const webhookUrl = resolveWahaWebhookUrl(new URL(request.url).origin)
    const row = await loadConfig(ctx)
    const canConnect = await loadCanConnect(ctx)

    if (!row || row.provider !== 'waha' || row.waha_session_name !== sessionName) {
      return NextResponse.json({
        configured: false,
        sessionName,
        status: SESSION_UNAVAILABLE,
        qr: null,
        webhookUrl,
        canConnect,
      })
    }

    const provider = providerFor(sessionName)
    if ('error' in provider) {
      return NextResponse.json({ error: provider.error }, { status: 500 })
    }
    return NextResponse.json(await readState(ctx, provider, webhookUrl, canConnect))
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const sessionName = wahaSessionNameForAccount(ctx.accountId)

    // Only accounts that arrived through an invitation may create a session.
    if (!(await loadCanConnect(ctx))) {
      return NextResponse.json(
        { error: t('whatsappConfig.notInvited') },
        { status: 403 },
      )
    }

    const secret = process.env.WAHA_WEBHOOK_SECRET?.trim()
    if (!secret) {
      return NextResponse.json(
        { error: 'WAHA_WEBHOOK_SECRET is not set on the server.' },
        { status: 500 },
      )
    }
    const provider = providerFor(sessionName)
    if ('error' in provider) {
      return NextResponse.json({ error: provider.error }, { status: 500 })
    }

    const webhookUrl = resolveWahaWebhookUrl(new URL(request.url).origin)
    const existing = await loadConfig(ctx)
    try {
      await ensureWahaRow(ctx, sessionName, existing)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to save' },
        { status: 409 },
      )
    }

    await provider.ensureSession({ webhookUrl, webhookSecret: secret })
    return NextResponse.json(await readState(ctx, provider, webhookUrl, true))
  } catch (err) {
    if (err instanceof WahaHttpError) {
      return NextResponse.json(
        { error: `WAHA error ${err.status}: ${err.message}` },
        { status: 502 },
      )
    }
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const sessionName = wahaSessionNameForAccount(ctx.accountId)
    const row = await loadConfig(ctx)
    if (!row || row.provider !== 'waha' || row.waha_session_name !== sessionName) {
      return NextResponse.json({ error: 'No WAHA session for this account.' }, { status: 404 })
    }
    const provider = providerFor(sessionName)
    if ('error' in provider) {
      return NextResponse.json({ error: provider.error }, { status: 500 })
    }
    await provider.logoutSession(sessionName)
    await syncStatus(ctx, 'STOPPED')
    const webhookUrl = resolveWahaWebhookUrl(new URL(request.url).origin)
    return NextResponse.json({
      configured: true,
      sessionName,
      status: 'STOPPED',
      qr: null,
      webhookUrl,
      canConnect: await loadCanConnect(ctx),
    })
  } catch (err) {
    if (err instanceof WahaHttpError) {
      return NextResponse.json(
        { error: `WAHA error ${err.status}: ${err.message}` },
        { status: 502 },
      )
    }
    return toErrorResponse(err)
  }
}
