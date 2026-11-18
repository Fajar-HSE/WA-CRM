import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { MAX_GROUP_TEXT } from '@/lib/groups/limits'
import { getT } from '@/lib/i18n/translate'
import { logError } from '@/lib/logging/error-log'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadWahaProvider } from '@/lib/whatsapp/waha-account'
import { isGroupChatId } from '@/lib/whatsapp/waha-groups'

const t = getT('Api')

/** Same length the webhook keeps for the group list preview. */
const PREVIEW_LENGTH = 200

/** Ids WAHA could not report; the `message.any` echo brings the real one. */
const LOCAL_ID_PREFIX = 'waha-local-'

/**
 * POST /api/whatsapp/groups/send  (agent)
 * Body: { group_id: string, text: string, reply_to_message_id?: string }
 *
 * Sends a text message to a monitored group from the linked number, as a
 * quote of `reply_to_message_id` when given. Text only: no media, no AI,
 * no automation. The message is also saved right away so it shows in the
 * thread without waiting for WAHA's echo (the echo is then a no-op).
 */
export async function POST(request: Request) {
  try {
    // Sending reaches a real WhatsApp group before anything is stored, so
    // the role is checked here and not left to row-level security.
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`wa-groups-send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      group_id?: unknown
      text?: unknown
      reply_to_message_id?: unknown
    } | null

    const groupId = typeof body?.group_id === 'string' ? body.group_id.trim() : ''
    if (!groupId) {
      return NextResponse.json({ error: t('groups.invalidGroup') }, { status: 400 })
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) {
      return NextResponse.json({ error: t('groups.textRequired') }, { status: 400 })
    }
    if (text.length > MAX_GROUP_TEXT) {
      return NextResponse.json(
        { error: t('groups.textTooLong', { max: MAX_GROUP_TEXT }) },
        { status: 400 },
      )
    }
    const replyTo =
      typeof body?.reply_to_message_id === 'string' && body.reply_to_message_id.trim()
        ? body.reply_to_message_id.trim()
        : undefined

    // Looked up with the caller's own client, so row-level security keeps
    // this to groups of the caller's account.
    const { data: group } = await supabase
      .from('whatsapp_groups')
      .select('id, jid, monitored')
      .eq('id', groupId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!group || !isGroupChatId(group.jid)) {
      return NextResponse.json({ error: t('groups.invalidGroup') }, { status: 404 })
    }
    if (!group.monitored) {
      return NextResponse.json({ error: t('groups.notMonitored') }, { status: 400 })
    }

    const provider = await loadWahaProvider(supabase, accountId)
    if (!provider) {
      return NextResponse.json({ error: t('groups.notWaha') }, { status: 400 })
    }

    let messageId: string
    try {
      const sent = await provider.sendText({
        to: group.jid as string,
        text,
        contextMessageId: replyTo,
      })
      messageId = sent.messageId
    } catch (err) {
      await logError('whatsapp.groups.send', err, {
        accountId,
        context: { groupId: group.id, quoted: !!replyTo },
      })
      return NextResponse.json({ error: t('groups.sendFailed') }, { status: 502 })
    }

    // The message is already out. Saving it is for the thread's sake; a
    // failure here must not make the sender think nothing was delivered.
    const sentAt = new Date().toISOString()
    let saved = false
    if (messageId && !messageId.startsWith(LOCAL_ID_PREFIX)) {
      const db = supabaseAdmin()
      const { data: rows, error } = await db
        .from('whatsapp_group_messages')
        .upsert(
          {
            group_id: group.id,
            account_id: accountId,
            message_id: messageId,
            from_me: true,
            sender_phone: null,
            sender_name: null,
            content_type: 'text',
            content_text: text,
            created_at: sentAt,
          },
          { onConflict: 'group_id,message_id', ignoreDuplicates: true },
        )
        .select('id')
      if (error) {
        await logError('whatsapp.groups.send', error, {
          accountId,
          level: 'warning',
          context: { stage: 'save', groupId: group.id },
        })
      } else if (rows && rows.length > 0) {
        saved = true
        await db
          .from('whatsapp_groups')
          .update({ last_message_at: sentAt, last_message_text: text.slice(0, PREVIEW_LENGTH) })
          .eq('id', group.id)
      }
    }

    return NextResponse.json({ ok: true, message_id: messageId, saved })
  } catch (err) {
    return toErrorResponse(err)
  }
}
