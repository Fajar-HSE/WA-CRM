import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { WahaHttpError } from '@/lib/whatsapp/providers/waha'
import { loadWahaProvider } from '@/lib/whatsapp/waha-account'
import { isGroupChatId, resolveGroupMembers } from '@/lib/whatsapp/waha-groups'

const t = getT('Api')

export const maxDuration = 60

/**
 * GET /api/whatsapp/groups/members?jid=<group id>  (admin)
 *
 * Members of one group with their phone numbers where WhatsApp reveals them.
 * Read-only: nothing is saved. Hidden numbers (LIDs) are looked up; the
 * answer says how many stayed unknown.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`wa-groups-members:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const jid = new URL(request.url).searchParams.get('jid')?.trim() ?? ''
    if (!isGroupChatId(jid)) {
      return NextResponse.json({ error: t('groups.invalidGroup') }, { status: 400 })
    }

    const provider = await loadWahaProvider(supabase, accountId)
    if (!provider) {
      return NextResponse.json({ error: t('groups.notWaha') }, { status: 400 })
    }

    try {
      const res = await resolveGroupMembers(provider, jid)
      return NextResponse.json({
        members: res.members.map((m) => ({ id: m.id, phone: m.phone, is_admin: m.isAdmin })),
        total: res.total,
        unresolved: res.unresolved,
        truncated: res.truncated,
      })
    } catch (err) {
      if (err instanceof WahaHttpError) {
        console.error('[whatsapp/groups/members] WAHA error:', err.message)
        return NextResponse.json({ error: t('groups.wahaFailed') }, { status: 502 })
      }
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
