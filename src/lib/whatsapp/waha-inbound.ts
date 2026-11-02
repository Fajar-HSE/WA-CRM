import { supabaseAdmin } from '@/lib/flows/admin-client'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { claimFirstInboundMessage } from '@/lib/conversations/first-inbound'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// NOTE: reopenClosedConversation / claimFirstInboundMessage may live in
// different modules; adjust imports if typecheck complains.

export interface WahaInboundInput {
  sessionName: string
  payload: any
}

function extractPhone(from: string): string {
  if (!from) return ''
  const part = from.split('@')[0]
  return part.replace(/[^\d]/g, '')
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
  const phone = extractPhone(from)
  const lid = from.includes('@lid') ? from.split('@')[0] : null

  // Find or create contact.
  let contact: any = null
  if (phone) {
    contact = await findExistingContact(db, accountId, phone)
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

  let conversation: any = null
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
  const automationTriggers: any[] = []
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
    }).catch((err: any) => console.error('[waha-inbound] automation failed:', err))
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
