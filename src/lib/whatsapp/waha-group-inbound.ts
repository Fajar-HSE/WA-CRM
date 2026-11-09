import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getT } from '@/lib/i18n/translate'
import { createWhatsAppProvider } from '@/lib/whatsapp/providers'
import { WahaWhatsAppProvider } from '@/lib/whatsapp/providers/waha'
import { altPhoneFromPayload, phoneFromJid, pushNameFromPayload } from '@/lib/whatsapp/waha-ids'
import { isGroupChatId } from '@/lib/whatsapp/waha-groups'
import type { WhatsAppConfig } from '@/types'

const t = getT('LibErrors')

const PREVIEW_LENGTH = 200

/** The subset of a WAHA group message this module reads. */
export interface WahaGroupPayload {
  id?: string | null
  from?: string | null
  to?: string | null
  fromMe?: boolean
  body?: string | null
  timestamp?: number | null
  hasMedia?: boolean
  /** Who wrote it, inside a group: `<digits>@c.us` or an opaque `@lid`. */
  participant?: string | null
  [key: string]: unknown
}

/**
 * A message in a WhatsApp group.
 *
 * Saved only for groups an admin chose to monitor; every other group is
 * dropped here, before anything is written. It never creates a contact,
 * conversation or message, so the inbox, dashboard, automations, flows and
 * the AI auto-reply cannot see it. Media is not downloaded: a file shows as
 * a marker.
 */
export async function processWahaGroupMessage({
  sessionName,
  payload,
}: {
  sessionName: string
  payload: WahaGroupPayload
}): Promise<void> {
  const fromMe = payload?.fromMe === true
  const chatId = String((fromMe ? payload?.to : payload?.from) ?? '')
  const messageId = payload?.id || null
  if (!isGroupChatId(chatId) || !messageId) return

  const db = supabaseAdmin()

  const { data: config } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('waha_session_name', sessionName)
    .maybeSingle()
  if (!config) return
  const accountId = config.account_id as string

  const { data: group } = await db
    .from('whatsapp_groups')
    .select('id, subject, monitored')
    .eq('account_id', accountId)
    .eq('jid', chatId)
    .maybeSingle()
  if (!group || !group.monitored) return

  const { data: acct } = await db
    .from('accounts')
    .select('disabled_at')
    .eq('id', accountId)
    .maybeSingle()
  if (acct?.disabled_at) return

  const participant = typeof payload.participant === 'string' ? payload.participant : null
  const senderPhone = fromMe
    ? null
    : (phoneFromJid(participant) ?? altPhoneFromPayload(payload as Record<string, unknown>))
  const senderName = fromMe ? null : pushNameFromPayload(payload as Record<string, unknown>)

  const hasMedia = !!payload.hasMedia
  const body = typeof payload.body === 'string' ? payload.body : ''
  const text = body || (hasMedia ? t('waha.historyAttachment') : '')
  if (!text) return

  const sentAt = new Date((payload.timestamp || Date.now() / 1000) * 1000).toISOString()

  const { data: rows, error } = await db
    .from('whatsapp_group_messages')
    .upsert(
      {
        group_id: group.id,
        account_id: accountId,
        message_id: messageId,
        from_me: fromMe,
        sender_phone: senderPhone,
        sender_name: senderName,
        content_type: hasMedia ? 'media' : 'text',
        content_text: text,
        created_at: sentAt,
      },
      { onConflict: 'group_id,message_id', ignoreDuplicates: true },
    )
    .select('id')
  if (error) {
    console.error('[waha-group] message insert failed:', error.message)
    return
  }
  // A replay (the same message on `message` and `message.any`).
  if (!rows || rows.length === 0) return

  await db
    .from('whatsapp_groups')
    .update({ last_message_at: sentAt, last_message_text: text.slice(0, PREVIEW_LENGTH) })
    .eq('id', group.id)

  // Learn the group's name once, if it was saved without one.
  if (!group.subject) {
    try {
      const provider = createWhatsAppProvider(config as WhatsAppConfig)
      if (provider instanceof WahaWhatsAppProvider) {
        const info = await provider.getGroup(chatId)
        if (info?.subject) {
          await db.from('whatsapp_groups').update({ subject: info.subject }).eq('id', group.id)
        }
      }
    } catch {
      // The name is cosmetic; the message is already saved.
    }
  }
}
