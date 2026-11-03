// ============================================================
// WhatsApp chat-id helpers for the WAHA provider.
//
// Newer WhatsApp hides a sender's phone number behind a "LID": an
// opaque id such as 30601675599946@lid. It is NOT a phone number, but
// it is made of digits, so storing it as the contact's phone and later
// sending to `<digits>@c.us` reaches nobody. WAHA accepts the request,
// WhatsApp drops it, and the message sits at one tick forever.
// ============================================================

/** LIDs observed so far are 14-15 digits; real numbers (E.164) stop at 15 and Indonesian ones at 13. */
const LID_MIN_DIGITS = 14

/** Digits-only form of a phone, jid or chat id. */
export function digitsOf(value: string): string {
  return value.replace(/\D/g, '')
}

export function isLidChatId(chatId: string | null | undefined): boolean {
  return typeof chatId === 'string' && chatId.endsWith('@lid')
}

/**
 * A bare digit string long enough to be a LID rather than a phone.
 * Only a hint: used when WAHA says the number is not on WhatsApp, to
 * decide between "wrong number" and "this is an opaque id".
 */
export function looksLikeLidNumber(digits: string): boolean {
  return /^\d+$/.test(digits) && digits.length >= LID_MIN_DIGITS
}

/** Phone digits from a `…@c.us` / `…@s.whatsapp.net` jid, else null. */
export function phoneFromJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null
  const m = /^(\d{6,16})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(jid.trim())
  return m ? m[1] : null
}

type Loose = Record<string, unknown> | null | undefined

function pick(obj: Loose, ...path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/**
 * Real phone number carried alongside a LID sender, when the engine
 * provides one. Field names differ per WAHA engine (NOWEB, GOWS, WEBJS),
 * so look in each of the known places.
 */
export function altPhoneFromPayload(payload: Loose): string | null {
  const candidates = [
    pick(payload, '_data', 'key', 'remoteJidAlt'),
    pick(payload, '_data', 'key', 'participantAlt'),
    pick(payload, '_data', 'Info', 'SenderAlt'),
    pick(payload, '_data', 'Info', 'RecipientAlt'),
    pick(payload, 'remoteJidAlt'),
  ]
  for (const c of candidates) {
    const phone = phoneFromJid(c)
    if (phone) return phone
  }
  return null
}

export type WahaMessageStatus = 'sent' | 'delivered' | 'read' | 'failed'

/**
 * Map a WAHA `message.ack` onto the CRM's message status.
 * -1 error, 0 pending, 1 server (sent), 2 device (delivered), 3 read, 4 played.
 */
export function ackToStatus(
  ack: unknown,
  ackName?: unknown,
): WahaMessageStatus | null {
  if (typeof ack === 'number') {
    if (ack < 0) return 'failed'
    if (ack === 1) return 'sent'
    if (ack === 2) return 'delivered'
    if (ack >= 3) return 'read'
    return null
  }
  switch (typeof ackName === 'string' ? ackName.toUpperCase() : '') {
    case 'ERROR':
      return 'failed'
    case 'SERVER':
      return 'sent'
    case 'DEVICE':
      return 'delivered'
    case 'READ':
    case 'PLAYED':
      return 'read'
    default:
      return null
  }
}
