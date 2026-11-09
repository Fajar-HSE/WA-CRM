import type { SupabaseClient } from '@supabase/supabase-js'

import { getT } from '@/lib/i18n/translate'
import type { WahaHistoryMessage } from '@/lib/whatsapp/providers/waha'

const t = getT('LibErrors')

/** Rows are written in slices this size. */
const INSERT_BATCH = 100

export interface HistoryProvider {
  listChatMessages(
    to: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<WahaHistoryMessage[]>
}

export interface HistoryImportResult {
  /** Messages WAHA returned for this page. */
  fetched: number
  /** Messages newly written to the conversation. */
  imported: number
  /** Messages that were already there, or carry nothing to show. */
  skipped: number
  /** True when WAHA returned a full page, so older ones may exist. */
  hasMore: boolean
}

export class HistoryImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HistoryImportError'
  }
}

interface ConversationRow {
  id: string
  contact: { phone: string | null } | { phone: string | null }[] | null
}

/** One WAHA message as a `messages` row, or null if there is nothing to show. */
export function historyRow(
  m: WahaHistoryMessage,
  conversationId: string,
): Record<string, unknown> | null {
  const id = typeof m.id === 'string' ? m.id : ''
  const ts = typeof m.timestamp === 'number' ? m.timestamp : 0
  if (!id || !ts) return null

  const body = typeof m.body === 'string' ? m.body.trim() : ''
  const hasMedia = !!m.hasMedia
  // History is read without downloading media, so a file has no URL to
  // show. Keep a marker so the conversation still reads in order.
  const text = body || (hasMedia ? t('waha.historyAttachment') : '')
  if (!text) return null

  const fromMe = m.fromMe === true
  return {
    conversation_id: conversationId,
    sender_type: fromMe ? 'agent' : 'customer',
    content_type: 'text',
    content_text: text,
    media_url: null,
    message_id: id,
    status: fromMe ? 'sent' : 'delivered',
    created_at: new Date(ts * 1000).toISOString(),
  }
}

/**
 * Copy one page of a chat's older messages from WAHA into the CRM.
 *
 * Only messages the conversation does not have yet are written, so running
 * it twice is harmless. Nothing here touches the unread counter, flows,
 * automations or the AI: these are old messages, not new activity. The
 * database trigger still moves the conversation's first/last reply markers,
 * but only ever forward in time (GREATEST), so old rows cannot disturb them.
 */
export async function importChatHistory(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  provider: HistoryProvider
  limit?: number
  offset?: number
}): Promise<HistoryImportResult> {
  const { db, accountId, conversationId, provider } = args
  const limit = args.limit ?? 100

  const { data: conv, error } = await db
    .from('conversations')
    .select('id, contact:contacts(phone)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !conv) throw new HistoryImportError(t('waha.historyNoConversation'), 404)

  const embedded = (conv as ConversationRow).contact
  const contact = Array.isArray(embedded) ? embedded[0] : embedded
  const phone = contact?.phone?.trim() ?? ''
  if (!phone) throw new HistoryImportError(t('waha.historyNoPhone'), 400)

  const messages = await provider.listChatMessages(phone, { limit, offset: args.offset ?? 0 })
  const fetched = messages.length

  const rows = messages
    .map((m) => historyRow(m, conversationId))
    .filter((r): r is Record<string, unknown> => r !== null)

  if (rows.length === 0) {
    return { fetched, imported: 0, skipped: fetched, hasMore: fetched >= limit }
  }

  const ids = rows.map((r) => r.message_id as string)
  const have = new Set<string>()
  for (let i = 0; i < ids.length; i += INSERT_BATCH) {
    const { data: existing, error: existingErr } = await db
      .from('messages')
      .select('message_id')
      .eq('conversation_id', conversationId)
      .in('message_id', ids.slice(i, i + INSERT_BATCH))
    if (existingErr) throw new HistoryImportError(existingErr.message, 500)
    for (const e of (existing ?? []) as { message_id: string | null }[]) {
      if (e.message_id) have.add(e.message_id)
    }
  }

  const fresh = rows.filter((r) => !have.has(r.message_id as string))
  for (let i = 0; i < fresh.length; i += INSERT_BATCH) {
    const { error: insertErr } = await db
      .from('messages')
      .upsert(fresh.slice(i, i + INSERT_BATCH), {
        onConflict: 'conversation_id,message_id',
        ignoreDuplicates: true,
      })
    if (insertErr) throw new HistoryImportError(insertErr.message, 500)
  }

  return {
    fetched,
    imported: fresh.length,
    skipped: fetched - fresh.length,
    hasMore: fetched >= limit,
  }
}
