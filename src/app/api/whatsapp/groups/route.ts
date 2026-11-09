import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { WahaHttpError } from '@/lib/whatsapp/providers/waha'
import { loadWahaProvider } from '@/lib/whatsapp/waha-account'

const t = getT('Api')

interface GroupRow {
  id: string
  jid: string
  subject: string | null
  monitored: boolean
  last_message_at: string | null
  last_message_text: string | null
}

/**
 * GET /api/whatsapp/groups  (admin)
 *
 * The groups this WhatsApp number belongs to (live from WAHA), each with
 * whether an admin chose to monitor it. Groups saved earlier that WAHA no
 * longer lists (the number left) are included so their history stays reachable.
 */
export async function GET() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`wa-groups:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const provider = await loadWahaProvider(supabase, accountId)
    if (!provider) {
      return NextResponse.json({ error: t('groups.notWaha') }, { status: 400 })
    }

    let live
    try {
      live = await provider.listGroups()
    } catch (err) {
      if (err instanceof WahaHttpError) {
        console.error('[whatsapp/groups] WAHA error:', err.message)
        return NextResponse.json({ error: t('groups.wahaFailed') }, { status: 502 })
      }
      throw err
    }

    const { data: saved } = await supabase
      .from('whatsapp_groups')
      .select('id, jid, subject, monitored, last_message_at, last_message_text')
      .eq('account_id', accountId)
    const byJid = new Map(((saved ?? []) as GroupRow[]).map((g) => [g.jid, g]))

    const groups = live.map((g) => {
      const row = byJid.get(g.id)
      byJid.delete(g.id)
      return {
        jid: g.id,
        subject: g.subject ?? row?.subject ?? null,
        size: g.size,
        monitored: row?.monitored ?? false,
        last_message_at: row?.last_message_at ?? null,
        last_message_text: row?.last_message_text ?? null,
        left: false,
      }
    })
    for (const row of byJid.values()) {
      groups.push({
        jid: row.jid,
        subject: row.subject,
        size: null,
        monitored: row.monitored,
        last_message_at: row.last_message_at,
        last_message_text: row.last_message_text,
        left: true,
      })
    }

    return NextResponse.json({ groups })
  } catch (err) {
    return toErrorResponse(err)
  }
}
