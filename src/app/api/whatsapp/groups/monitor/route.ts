import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadWahaProvider } from '@/lib/whatsapp/waha-account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isGroupChatId } from '@/lib/whatsapp/waha-groups'

const t = getT('Api')

const MAX_SUBJECT = 200

/**
 * POST /api/whatsapp/groups/monitor  (admin)
 * Body: { jid: string, subject?: string, enabled: boolean }
 *
 * Turns saving of a group's messages on or off. Until a group is turned on,
 * the webhook drops its messages without writing anything.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`wa-groups-monitor:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      jid?: unknown
      subject?: unknown
      enabled?: unknown
    } | null
    const jid = typeof body?.jid === 'string' ? body.jid.trim() : ''
    if (!isGroupChatId(jid) || typeof body?.enabled !== 'boolean') {
      return NextResponse.json({ error: t('groups.invalidGroup') }, { status: 400 })
    }
    if (!(await loadWahaProvider(supabase, accountId))) {
      return NextResponse.json({ error: t('groups.notWaha') }, { status: 400 })
    }
    const subject =
      typeof body.subject === 'string' && body.subject.trim()
        ? body.subject.trim().slice(0, MAX_SUBJECT)
        : null

    const row: Record<string, unknown> = {
      account_id: accountId,
      jid,
      monitored: body.enabled,
    }
    if (subject) row.subject = subject

    const { data, error } = await supabaseAdmin()
      .from('whatsapp_groups')
      .upsert(row, { onConflict: 'account_id,jid' })
      .select('id, jid, subject, monitored')
      .single()
    if (error || !data) {
      console.error('[whatsapp/groups/monitor] upsert failed:', error?.message)
      return NextResponse.json({ error: t('groups.saveFailed') }, { status: 500 })
    }
    return NextResponse.json({ group: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
