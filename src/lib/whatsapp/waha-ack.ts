import { supabaseAdmin } from '@/lib/flows/admin-client'
import { applyMessageStatus } from '@/lib/whatsapp/message-status-sync'
import { ackToStatus } from '@/lib/whatsapp/waha-ids'

/** The part of WAHA's `message.ack` payload this module reads. */
export interface WahaAckPayload {
  id?: unknown
  fromMe?: boolean
  ack?: unknown
  ackName?: unknown
}

function messageIdOf(id: unknown): string {
  if (typeof id === 'string') return id
  if (id && typeof id === 'object') {
    const serialized = (id as { _serialized?: unknown })._serialized
    if (typeof serialized === 'string') return serialized
  }
  return ''
}

/**
 * Turn a WAHA delivery receipt into the message's status, so the inbox
 * ticks reflect reality (sent → delivered → read, or failed) instead of
 * stopping at "sent" the moment WAHA accepted the request.
 */
export async function processWahaAck({
  sessionName,
  payload,
}: {
  sessionName: string
  payload: WahaAckPayload
}): Promise<void> {
  // Receipts for messages the customer sent to us are not ours to track.
  if (payload.fromMe === false) return

  const status = ackToStatus(payload.ack, payload.ackName)
  const wamid = messageIdOf(payload.id)
  if (!status || !wamid) return

  const db = supabaseAdmin()
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('account_id')
    .eq('waha_session_name', sessionName)
    .maybeSingle()
  if (error || !config) {
    console.error('[waha-ack] no config for session', sessionName, error?.message)
    return
  }

  await applyMessageStatus(db, config.account_id as string, {
    wamid,
    status,
    failure:
      status === 'failed'
        ? { code: -1, title: 'WhatsApp gagal mengirim pesan', details: null }
        : null,
    statusAt: new Date().toISOString(),
  })
}
