import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { GRAB_BATCH_LIMIT, grabMembersToContacts, isGroupChatId } from '@/lib/whatsapp/waha-groups'

const t = getT('Api')

export const maxDuration = 60

/**
 * POST /api/whatsapp/groups/grab  (admin)
 * Body: { jid: string, group_name: string, members: { phone: string, name?: string }[] }
 *
 * Saves the chosen members as contacts tagged with the group's name. Existing
 * contacts are only tagged. Sends nothing to anyone. The dialog posts big
 * groups in slices of GRAB_BATCH_LIMIT.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`wa-groups-grab:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      jid?: unknown
      group_name?: unknown
      members?: unknown
    } | null
    const jid = typeof body?.jid === 'string' ? body.jid.trim() : ''
    if (!isGroupChatId(jid) || !Array.isArray(body?.members)) {
      return NextResponse.json({ error: t('groups.invalidGroup') }, { status: 400 })
    }
    if (body.members.length === 0) {
      return NextResponse.json({ error: t('groups.noMembers') }, { status: 400 })
    }
    if (body.members.length > GRAB_BATCH_LIMIT) {
      return NextResponse.json({ error: t('groups.tooMany', { max: GRAB_BATCH_LIMIT }) }, { status: 400 })
    }

    const members = (body.members as unknown[]).flatMap((m) => {
      if (!m || typeof m !== 'object') return []
      const o = m as { phone?: unknown; name?: unknown }
      if (typeof o.phone !== 'string') return []
      return [{ phone: o.phone, name: typeof o.name === 'string' ? o.name : null }]
    })

    const result = await grabMembersToContacts({
      db: supabaseAdmin(),
      accountId,
      userId,
      groupName: typeof body.group_name === 'string' ? body.group_name : '',
      members,
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
