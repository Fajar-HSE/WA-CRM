import { supabaseAdmin } from '@/lib/flows/admin-client'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { claimFirstInboundMessage } from '@/lib/conversations/first-inbound'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import type { AutomationTriggerType, WhatsAppConfig } from '@/types'
import { createWhatsAppProvider } from '@/lib/whatsapp/providers'
import { WahaWhatsAppProvider } from '@/lib/whatsapp/providers/waha'
import { altPhoneFromPayload } from '@/lib/whatsapp/waha-ids'

// NOTE: reopenClosedConversation / claimFirstInboundMessage may live in
// different modules; adjust imports if typecheck complains.

/** The subset of WAHA's `message` payload this module reads. */
export interface WahaInboundPayload {
  id?: string | null
  from?: string | null
  body?: string | null
  timestamp?: number | null
  hasMedia?: boolean
  fromMe?: boolean
  notifyName?: string | null
  media?: { url?: string | null; mimetype?: string | null } | null
  _data?: {
    notifyName?: string | null
    /** NOWEB: carries the real number next to a LID sender. */
    key?: { remoteJidAlt?: string | null; participantAlt?: string | null } | null
    /** GOWS: same idea. */
    Info?: { SenderAlt?: string | null; RecipientAlt?: string | null } | null
  } | null
}

export interface WahaInboundInput {
  sessionName: string
  payload: WahaInboundPayload
}

interface InboundContact {
  id: string
}

interface InboundConversation {
  id: string
  status?: string | null
  first_inbound_at?: string | null
}

function extractPhone(from: string): string {
  if (!from) return ''
  const part = from.split('@')[0]
  return part.replace(/[^\d]/g, '')
}

async function lookupPhoneForLid(config: WhatsAppConfig, lid: string): Promise<string | null> {
  try {
    const provider = createWhatsAppProvider(config)
    if (!(provider instanceof WahaWhatsAppProvider)) return null
    return await provider.getPhoneForLid(lid)
  } catch (err) {
    console.warn('[waha-inbound] lid lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export async function processWahaInbound({ sessionName, payload }: WahaInboundInput): Promise<void> {
  const db = supabaseAdmin()

  // Resolve account from session name.
  const { data: config, error: cfgErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('waha_session_name', sessionName)
    .maybeSingle()

  if (cfgErr || !config) {
    console.error('[waha-inbound] no config for session', sessionName, cfgErr?.message)
    return
  }

  const accountId = config.account_id as string
  const ownerUserId = config.user_id as string

  const from = String(payload?.from || '')
  const isLid = from.endsWith('@lid')
  const lidDigits = isLid ? extractPhone(from) : null
  let phone = extractPhone(from)

  // A LID is an opaque id, not a phone number. Replying to it as if it
  // were one reaches nobody, so find the real number: first in the
  // payload itself, then by asking WAHA.
  if (isLid) {
    const real =
      altPhoneFromPayload(payload as Record<string, unknown>) ??
      (await lookupPhoneForLid(config as WhatsAppConfig, from))
    if (real) phone = real
  }

  // Find or create contact.
  let contact: InboundContact | null = null
  if (phone) {
    contact = await findExistingContact(db, accountId, phone)
  }

  // Contacts saved before this fix hold the LID digits as their "phone".
  // Now that the real number is known, correct that contact in place so
  // its history and the conversation stay together.
  if (isLid && lidDigits && phone !== lidDigits) {
    const legacy = await findExistingContact(db, accountId, lidDigits)
    if (legacy && !contact) {
      const { error: fixErr } = await db
        .from('contacts')
        .update({ phone })
        .eq('id', legacy.id)
        .eq('account_id', accountId)
      contact = fixErr ? legacy : { ...legacy, phone }
      if (fixErr) {
        console.error('[waha-inbound] could not correct lid contact:', fixErr.message)
      }
    }
  }
  let wasCreated = false
  if (!contact) {
    const { data: newContact, error: createErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        phone: phone || from,
        name: payload?._data?.notifyName || payload?.notifyName || phone || from,
      })
      .select()
      .single()
    if (createErr) {
      console.error('[waha-inbound] contact create failed:', createErr.message)
      // try resolve again
      if (phone) contact = await findExistingContact(db, accountId, phone)
    } else {
      contact = newContact
      wasCreated = true
    }
  }
  if (!contact) return

  // Find or create conversation.
  const { data: existingConvs } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: true })
    .limit(1)

  let conversation: InboundConversation | null = null
  let convCreated = false
  if (existingConvs && existingConvs.length > 0) {
    conversation = existingConvs[0]
  } else {
    const { data: newConv, error: convErr } = await db
      .from('conversations')
      .insert({ account_id: accountId, user_id: ownerUserId, contact_id: contact.id })
      .select()
      .single()
    if (convErr) {
      console.error('[waha-inbound] conv create failed:', convErr.message)
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) conversation = raced[0]
    } else {
      conversation = newConv
      convCreated = true
    }
  }
  if (!conversation) return

  if (convCreated) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    })
  }

  // Reaction? WAHA sends message.reaction separately; skip here.

  const receivedAt = new Date((payload?.timestamp || Date.now() / 1000) * 1000).toISOString()
  const contentText = payload?.body || null
  const hasMedia = !!payload?.hasMedia
  const mediaUrl = hasMedia ? payload?.media?.url || null : null
  const mediaType = hasMedia ? payload?.media?.mimetype || null : null
  const messageId = payload?.id || null

  // Idempotent insert.
  const { data: insertedRows, error: msgErr } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: hasMedia ? (mediaType?.startsWith('image') ? 'image' : mediaType?.startsWith('video') ? 'video' : mediaType?.startsWith('audio') ? 'audio' : 'document') : 'text',
        content_text: contentText,
        media_url: mediaUrl,
        media_type: mediaType,
        message_id: messageId,
        status: 'delivered',
        created_at: receivedAt,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgErr) {
    console.error('[waha-inbound] message insert failed:', msgErr.message)
    return
  }
  if (!insertedRows || insertedRows.length === 0) {
    // replay
    return
  }

  const isFirstInboundMessage = await claimFirstInboundMessage(db, conversation, receivedAt)

  await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || (hasMedia ? `[${mediaType}]` : '[message]'),
  })

  await reopenClosedConversation(db, conversation)

  // Flows dispatch
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: ownerUserId,
    contactId: contact.id,
    conversationId: conversation.id,
    message: { kind: 'text', text: contentText || '', meta_message_id: messageId || '' },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult?.consumed || false

  // Automations
  const inboundText = contentText || ''
  const automationTriggers: AutomationTriggerType[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contact.id,
      context: { message_text: inboundText, conversation_id: conversation.id },
    }).catch((err: unknown) => console.error('[waha-inbound] automation failed:', err))
  }

  // AI auto-reply
  if (!flowConsumed && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId: ownerUserId,
      inboundMessageId: messageId || '',
    })
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: messageId,
    content_type: hasMedia ? 'image' : 'text',
    text: contentText,
  })
}
