// ============================================================
// WAHA (WhatsApp HTTP API) adapter.
//
// Implements the WhatsAppProvider contract against WAHA's REST API.
// Requires a running WAHA instance (Docker). Configure via env:
//   WAHA_BASE_URL, WAHA_API_KEY
// The base URL and API key come from the server environment only —
// never from a database row a tenant can edit, otherwise an admin
// could point the adapter at their own host and read the API key.
// ============================================================

import { randomUUID } from 'node:crypto'
import type {
  WhatsAppProvider,
  WhatsAppProviderCredentials,
  WhatsAppSendResult,
  WhatsAppMediaInfo,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  GetMediaUrlArgs,
} from './provider'
import { WAHA_WEBHOOK_SECRET_HEADER } from '../waha-config'
import { looksLikeLidNumber, phoneFromJid } from '../waha-ids'
import { renderTemplateBody, templateBodyParams } from '../template-body'

export class WahaHttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message)
    this.name = 'WahaHttpError'
  }
}

/**
 * Thrown instead of sending a template whose `{{...}}` placeholders were not
 * all filled in. WAHA would deliver the literal "{{1}}" to the customer.
 */
export class WahaTemplateVariableError extends Error {
  constructor(public missing: string[]) {
    super(
      `Variabel template belum diisi: ${missing.map((m) => `{{${m}}}`).join(', ')}. ` +
        'Isi nilainya (atau pilih kolom kontak) sebelum template dikirim.',
    )
    this.name = 'WahaTemplateVariableError'
  }
}

/** Thrown when WAHA confirms a number is not registered on WhatsApp. */
export class WahaNumberNotFoundError extends Error {
  constructor(public digits: string) {
    super(`Nomor ${digits} tidak terdaftar di WhatsApp. Periksa nomor kontak ini.`)
    this.name = 'WahaNumberNotFoundError'
  }
}

export interface EnsureSessionOptions {
  /** Where WAHA should POST inbound events. */
  webhookUrl: string
  /** Sent back as the X-Webhook-Secret header on every delivery. */
  webhookSecret: string
}

interface WahaWebhookConfig {
  url?: string
  events?: string[]
  customHeaders?: { name?: string; value?: string }[] | null
}

interface WahaSessionInfo {
  name?: string
  status?: string
  config?: {
    webhooks?: WahaWebhookConfig[] | null
    noweb?: { store?: { enabled?: boolean; fullSync?: boolean } | null } | null
  } | null
}

/** One message as WAHA returns it from the chat history endpoint. */
export interface WahaHistoryMessage {
  id?: string | null
  timestamp?: number | null
  fromMe?: boolean
  body?: string | null
  hasMedia?: boolean
  media?: { mimetype?: string | null } | null
}

/** A WhatsApp group as WAHA reports it. */
export interface WahaGroup {
  id: string
  subject: string | null
  /** Member count when WAHA says so, else null. */
  size: number | null
}

export interface WahaGroupParticipant {
  /** `<digits>@c.us`, or an opaque `<digits>@lid`. */
  id: string
  role: string | null
  /**
   * Phone number (digits) when WAHA already put it in the member's own
   * record next to a hidden id (field names differ by engine and version),
   * else null.
   */
  phone: string | null
}

/** Participants plus what was learnt on the way, for the "technical details" box. */
export interface WahaParticipantsDetail {
  participants: WahaGroupParticipant[]
  /** Property names seen in the members' records (names only, never values). */
  fields: string[]
  /** Whether the group's own record was read to fill in missing numbers. */
  groupFallback: 'not_needed' | 'used' | 'failed'
}

/**
 * Thrown when WAHA cannot list a chat's messages because its message store
 * is off. The NOWEB engine keeps no history unless `config.noweb.store` is
 * enabled (and then only for what it receives after that, plus whatever
 * WhatsApp syncs when the number is linked).
 */
export class WahaStoreDisabledError extends Error {
  constructor() {
    super('WAHA message store is not enabled for this session.')
    this.name = 'WahaStoreDisabledError'
  }
}

/**
 * Events the CRM consumes: inbound messages, `message.any` (the only event
 * that also carries messages typed on the phone itself), and delivery/read
 * receipts.
 */
export const WEBHOOK_EVENTS = ['message', 'message.any', 'message.ack']

/**
 * NOWEB message store. Off by default in WAHA, and without it no chat
 * history can be read back. `fullSync: false` keeps roughly the last three
 * months that WhatsApp sends when a number is linked.
 */
export const NOWEB_STORE_CONFIG = { enabled: true, fullSync: false }

function toChatId(to: string): string {
  const v = to.trim()
  if (v.includes('@')) return v
  const digits = v.replace(/[^\d]/g, '')
  return `${digits}@c.us`
}

function guessMime(kind: string, provided?: string): string {
  if (provided) return provided
  switch (kind) {
    case 'image':
      return 'image/jpeg'
    case 'video':
      return 'video/mp4'
    case 'audio':
      return 'audio/ogg; codecs=opus'
    default:
      return 'application/octet-stream'
  }
}

function serializedFrom(fromMe: unknown, remote: unknown, id: unknown): string {
  if (typeof remote === 'string' && typeof id === 'string' && id) {
    return `${fromMe === false ? 'false' : 'true'}_${remote}_${id}`
  }
  return ''
}

/**
 * Message id out of WAHA's send response. The shape depends on the engine:
 * a plain string, `{ _serialized }`, `{ fromMe, remote, id }` (WEBJS),
 * or a `key` object (NOWEB/GOWS), sometimes nested under `_data`.
 * Returns '' when none is recognised.
 */
export function messageIdOf(res: unknown): string {
  const r = (res ?? {}) as Record<string, unknown>
  const candidates: unknown[] = [r.id, r.messageId]
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>
      if (typeof o._serialized === 'string' && o._serialized) return o._serialized
      const composed = serializedFrom(o.fromMe, o.remote, o.id)
      if (composed) return composed
    }
  }
  const data = (r._data ?? {}) as Record<string, unknown>
  const dataId = data.id as Record<string, unknown> | undefined
  if (typeof dataId?._serialized === 'string' && dataId._serialized) return dataId._serialized
  for (const key of [r.key, data.key] as (Record<string, unknown> | undefined)[]) {
    const composed = serializedFrom(key?.fromMe, key?.remoteJid ?? key?.remote, key?.id)
    if (composed) return composed
  }
  return ''
}

/**
 * Id to store for a message we just sent. If WAHA's reply carries no id we
 * can recognise, mint a unique local one rather than returning ''. The
 * database keeps `messages (conversation_id, message_id)` and
 * `broadcast_recipients.wamid` unique, so an empty string makes the SECOND
 * send fail to save ("duplicate key") even though WhatsApp delivered it. A
 * local id cannot match a later receipt, which only costs the ticks.
 */
function sentMessageId(res: unknown): string {
  const id = messageIdOf(res)
  if (id) return id
  const shape =
    res && typeof res === 'object' ? Object.keys(res as Record<string, unknown>).join(',') : typeof res
  console.warn(`[waha] send response had no recognisable message id (keys: ${shape}); using a local id`)
  return `waha-local-${randomUUID()}`
}

export class WahaWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'waha' as const
  readonly sessionName: string
  readonly baseUrl: string
  readonly apiKey: string

  constructor(creds: WhatsAppProviderCredentials) {
    if (!creds.sessionName) throw new Error('WahaWhatsAppProvider requires sessionName')
    if (!creds.baseUrl) throw new Error('WahaWhatsAppProvider requires baseUrl')
    if (!creds.apiKey) throw new Error('WahaWhatsAppProvider requires apiKey')
    this.sessionName = creds.sessionName
    this.baseUrl = creds.baseUrl.replace(/\/+$/, '')
    this.apiKey = creds.apiKey
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Api-Key': this.apiKey,
        ...(init.headers || {}),
      },
    })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!res.ok) {
      throw new WahaHttpError(
        `WAHA ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        body,
      )
    }
    return body as T
  }

  private sessionPath(sessionName?: string): string {
    return `/api/sessions/${encodeURIComponent(sessionName || this.sessionName)}`
  }

  /**
   * Ask WAHA whether a number is on WhatsApp. `null` means "could not
   * find out" (older WAHA, engine without the endpoint, network error),
   * in which case callers fall back to the plain `<digits>@c.us` form.
   */
  private async checkNumber(
    digits: string,
  ): Promise<{ exists: boolean; chatId: string | null } | null> {
    try {
      const res = await this.request<{ numberExists?: unknown; chatId?: unknown } | null>(
        `/api/contacts/check-exists?phone=${encodeURIComponent(digits)}&session=${encodeURIComponent(this.sessionName)}`,
      )
      if (typeof res?.numberExists !== 'boolean') return null
      return {
        exists: res.numberExists,
        chatId: typeof res.chatId === 'string' ? res.chatId : null,
      }
    } catch {
      return null
    }
  }

  /**
   * Chat id to send to. A raw phone is verified with WAHA first so a
   * wrong number fails loudly instead of leaving a message at one tick,
   * and so WAHA's own canonical chat id is used. A number WAHA does not
   * know but that is long enough to be a LID is addressed as `@lid`.
   */
  private async resolveChatId(to: string): Promise<string> {
    const value = to.trim()
    if (value.includes('@')) return value
    const digits = value.replace(/[^\d]/g, '')
    if (!digits) throw new Error('Nomor tujuan kosong.')

    const check = await this.checkNumber(digits)
    if (check === null) return toChatId(digits)
    if (check.exists) return check.chatId || toChatId(digits)
    if (looksLikeLidNumber(digits)) return `${digits}@lid`
    throw new WahaNumberNotFoundError(digits)
  }

  /** Real phone number behind a LID, or null when WAHA does not know it. */
  async getPhoneForLid(lid: string): Promise<string | null> {
    return (await this.getLidMapping(lid)).phone
  }

  /** Same lookup, but says why it came back empty (no mapping vs. an error). */
  async getLidMapping(lid: string): Promise<{ phone: string | null; error: string | null }> {
    const full = lid.includes('@') ? lid : `${lid}@lid`
    try {
      const res = await this.request<{ pn?: unknown } | null>(
        `/api/${encodeURIComponent(this.sessionName)}/lids/${encodeURIComponent(full)}`,
      )
      return { phone: phoneFromJid(res?.pn), error: null }
    } catch (err) {
      return { phone: null, error: err instanceof WahaHttpError ? `HTTP ${err.status}` : 'network' }
    }
  }

  async sendText(args: SendTextArgs): Promise<WhatsAppSendResult> {
    const body: Record<string, unknown> = {
      session: this.sessionName,
      chatId: await this.resolveChatId(args.to),
      text: args.text,
    }
    if (args.contextMessageId) body.reply_to = args.contextMessageId
    const res = await this.request('/api/sendText', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return { messageId: sentMessageId(res) }
  }

  async sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult> {
    const chatId = await this.resolveChatId(args.to)
    const mime = guessMime(args.kind, args.mimeType)
    const file = {
      mimetype: mime,
      url: args.link,
      filename: args.filename,
    }
    let path = '/api/sendFile'
    if (args.kind === 'image') path = '/api/sendImage'
    else if (args.kind === 'video') path = '/api/sendVideo'
    else if (args.kind === 'audio') path = '/api/sendVoice'

    const body: Record<string, unknown> = {
      session: this.sessionName,
      chatId,
      file,
    }
    if (args.caption) body.caption = args.caption
    if (args.contextMessageId) body.reply_to = args.contextMessageId
    if (args.kind === 'audio') body.convert = false

    const res = await this.request(path, { method: 'POST', body: JSON.stringify(body) })
    return { messageId: sentMessageId(res) }
  }

  async sendTemplate(args: SendTemplateArgs): Promise<WhatsAppSendResult> {
    // WAHA has no template concept, so a template is plain text: the saved
    // body with its {{placeholders}} filled in (plus the footer, if any).
    const row = args.template as
      | { body_text?: string | null; footer_text?: string | null }
      | null
      | undefined
    let text: string
    if (row && typeof row.body_text === 'string' && row.body_text) {
      text = renderTemplateBody(row.body_text, templateBodyParams(args.params, args.messageParams))
      const unfilled = [...text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1])
      if (unfilled.length > 0) throw new WahaTemplateVariableError([...new Set(unfilled)])
      if (row.footer_text) text += `\n\n${row.footer_text}`
    } else {
      // No template row to read (it was deleted, or the caller gave none):
      // all we have is the name and the values.
      text =
        args.params && args.params.length
          ? `${args.templateName}: ${args.params.join(' ')}`
          : args.templateName
    }
    return this.sendText({ to: args.to, text, contextMessageId: args.contextMessageId })
  }

  async sendInteractiveButtons(
    args: SendInteractiveButtonsArgs,
  ): Promise<WhatsAppSendResult> {
    // Native buttons need WAHA Plus. Fall back to a numbered text list.
    const lines = [args.bodyText, '', ...args.buttons.map((b, i) => `${i + 1}. ${b.title}`)]
    return this.sendText({
      to: args.to,
      text: lines.join('\n'),
      contextMessageId: args.contextMessageId,
    })
  }

  async sendInteractiveList(args: SendInteractiveListArgs): Promise<WhatsAppSendResult> {
    const lines = [args.bodyText, '']
    for (const s of args.sections) {
      if (s.title) lines.push(`[${s.title}]`)
      for (const r of s.rows) {
        lines.push(`- ${r.title}${r.description ? `: ${r.description}` : ''}`)
      }
    }
    return this.sendText({
      to: args.to,
      text: lines.join('\n'),
      contextMessageId: args.contextMessageId,
    })
  }

  async getMediaUrl(args: GetMediaUrlArgs): Promise<WhatsAppMediaInfo> {
    // For WAHA, mediaId is already a URL.
    return { url: args.mediaId, mimeType: 'application/octet-stream', fileSize: 0 }
  }

  // ---- Session management ----

  /**
   * Create the session if it does not exist, make sure its webhook
   * points at this app (with the shared secret), and start it if it is
   * stopped. Safe to call repeatedly: a session whose webhook is already
   * correct is left alone, so a working (paired) session is not restarted.
   *
   * Without the webhook, WAHA never tells the CRM about inbound messages
   * — sending would work and receiving would silently not.
   */
  async ensureSession(opts: EnsureSessionOptions): Promise<void> {
    const config = {
      noweb: { store: NOWEB_STORE_CONFIG },
      webhooks: [
        {
          url: opts.webhookUrl,
          events: WEBHOOK_EVENTS,
          customHeaders: [
            { name: WAHA_WEBHOOK_SECRET_HEADER, value: opts.webhookSecret },
          ],
        },
      ],
    }

    let existing: WahaSessionInfo | null = null
    try {
      existing = await this.request<WahaSessionInfo>(this.sessionPath())
    } catch (err) {
      if (!(err instanceof WahaHttpError && err.status === 404)) throw err
    }

    if (!existing) {
      await this.request('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: this.sessionName, start: true, config }),
      })
      return
    }

    if (!webhookMatches(existing, opts) || !storeEnabled(existing)) {
      await this.request(this.sessionPath(), {
        method: 'PUT',
        body: JSON.stringify({ name: this.sessionName, config }),
      })
    }
    if (existing.status === 'STOPPED' || existing.status === 'FAILED') {
      await this.request(`${this.sessionPath()}/start`, { method: 'POST' })
    }
  }

  /**
   * Recent messages of one chat, newest first, as WAHA stores them. Media
   * is not downloaded. Throws WahaStoreDisabledError when the engine has no
   * message store.
   */
  async listChatMessages(
    to: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<WahaHistoryMessage[]> {
    const chatId = await this.resolveChatId(to)
    const qs = new URLSearchParams({
      limit: String(Math.min(Math.max(opts.limit ?? 100, 1), 200)),
      offset: String(Math.max(opts.offset ?? 0, 0)),
      downloadMedia: 'false',
      sortBy: 'timestamp',
      sortOrder: 'desc',
    })
    try {
      const res = await this.request<unknown>(
        `/api/${encodeURIComponent(this.sessionName)}/chats/${encodeURIComponent(chatId)}/messages?${qs}`,
      )
      return Array.isArray(res) ? (res as WahaHistoryMessage[]) : []
    } catch (err) {
      if (err instanceof WahaHttpError && /store/i.test(JSON.stringify(err.body ?? ''))) {
        throw new WahaStoreDisabledError()
      }
      throw err
    }
  }

  /** Groups the linked number belongs to. Shapes differ per engine, so parse loosely. */
  async listGroups(): Promise<WahaGroup[]> {
    const res = await this.request<unknown>(
      `/api/${encodeURIComponent(this.sessionName)}/groups?limit=500&sortBy=subject&sortOrder=asc`,
    )
    return parseWahaGroups(res)
  }

  /** One group's name, or null when WAHA cannot say. */
  async getGroup(groupId: string): Promise<WahaGroup | null> {
    try {
      const res = await this.request<unknown>(
        `/api/${encodeURIComponent(this.sessionName)}/groups/${encodeURIComponent(groupId)}`,
      )
      return parseWahaGroups([res])[0] ?? null
    } catch {
      return null
    }
  }

  /**
   * Members of a group. Tries the v2 endpoint (the one that reports roles and
   * LIDs consistently) and falls back to the original one.
   */
  async listGroupParticipants(groupId: string): Promise<WahaGroupParticipant[]> {
    return (await this.listGroupParticipantsDetailed(groupId)).participants
  }

  /**
   * Same list, plus diagnostics. A member shown only as a hidden id may still
   * carry the real number in a side field, or in the group's own record, so
   * both are read before giving up.
   */
  async listGroupParticipantsDetailed(groupId: string): Promise<WahaParticipantsDetail> {
    const groupPath = `/api/${encodeURIComponent(this.sessionName)}/groups/${encodeURIComponent(groupId)}`
    const base = `${groupPath}/participants`
    let res: unknown
    try {
      res = await this.request<unknown>(`${base}/v2`)
    } catch (err) {
      if (!(err instanceof WahaHttpError && (err.status === 404 || err.status === 501))) throw err
      res = await this.request<unknown>(base)
    }

    const participants = parseWahaParticipants(res)
    const fields = new Set(participantFieldNames(res))
    let groupFallback: WahaParticipantsDetail['groupFallback'] = 'not_needed'

    if (participants.some((p) => !p.phone && !phoneFromJid(p.id))) {
      try {
        const group = await this.request<unknown>(groupPath)
        for (const f of participantFieldNames(group)) fields.add(`group.${f}`)
        const byId = new Map(
          parseWahaParticipants(group)
            .filter((p) => p.phone)
            .map((p) => [p.id, p.phone as string]),
        )
        for (const p of participants) {
          if (!p.phone && byId.has(p.id)) p.phone = byId.get(p.id) as string
        }
        groupFallback = 'used'
      } catch {
        groupFallback = 'failed'
      }
    }
    return { participants, fields: [...fields].sort(), groupFallback }
  }

  async startSession(sessionName: string): Promise<void> {
    await this.request(`${this.sessionPath(sessionName)}/start`, { method: 'POST' })
  }

  async stopSession(sessionName: string): Promise<void> {
    await this.request(`${this.sessionPath(sessionName)}/stop`, { method: 'POST' })
  }

  async getSessionStatus(sessionName: string): Promise<string> {
    const res = await this.request<WahaSessionInfo>(this.sessionPath(sessionName))
    return res?.status ?? 'UNKNOWN'
  }

  /**
   * QR code as a `data:` URL ready for an <img>. WAHA answers with the
   * raw image unless JSON is requested; JSON gives `{ mimetype, data }`
   * where `data` is base64.
   */
  async getQrCode(sessionName: string): Promise<string | null> {
    try {
      const res = await this.request<{ mimetype?: string; data?: string } | null>(
        `/api/${encodeURIComponent(sessionName || this.sessionName)}/auth/qr`,
      )
      if (!res?.data) return null
      return `data:${res.mimetype || 'image/png'};base64,${res.data}`
    } catch {
      return null
    }
  }

  async logoutSession(sessionName: string): Promise<void> {
    await this.request(`${this.sessionPath(sessionName)}/logout`, { method: 'POST' })
  }
}

function jidOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o._serialized === 'string') return o._serialized
    if (typeof o.id === 'string') return o.id
    if (typeof o.user === 'string' && typeof o.server === 'string') return `${o.user}@${o.server}`
  }
  return ''
}

/** Group list as WAHA returns it (an array, or an object keyed by group id). */
export function parseWahaGroups(raw: unknown): WahaGroup[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.values(raw as Record<string, unknown>)
      : []
  const out: WahaGroup[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = jidOf(o.id) || jidOf(o.JID) || jidOf(o.jid)
    if (!id.endsWith('@g.us')) continue
    const subject =
      typeof o.subject === 'string' ? o.subject
      : typeof o.Name === 'string' ? o.Name
      : typeof o.name === 'string' ? o.name
      : null
    const participants = Array.isArray(o.participants)
      ? o.participants
      : Array.isArray(o.Participants)
        ? o.Participants
        : null
    const size =
      typeof o.size === 'number' ? o.size : participants ? participants.length : null
    out.push({ id, subject: subject?.trim() || null, size })
  }
  return out
}

/** A phone number (digits) found anywhere in one participant record, or null. */
function phoneInRecord(o: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(o)) {
    if (key === 'id') continue
    const jid = jidOf(value)
    const fromJid = jid ? phoneFromJid(jid) : null
    if (fromJid) return fromJid
    // A bare number in a field that is named like one ("phoneNumber", "pn").
    if (typeof value === 'string' && /(^pn$|phone|number)/i.test(key)) {
      const digits = value.replace(/\D/g, '')
      if (digits.length >= 8 && digits.length <= 15) return digits
    }
  }
  return null
}

function participantList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const o = raw as { participants?: unknown; Participants?: unknown }
    if (Array.isArray(o.participants)) return o.participants
    if (Array.isArray(o.Participants)) return o.Participants
  }
  return []
}

/** Property names present in a members list (names only, so it is safe to show). */
export function participantFieldNames(raw: unknown): string[] {
  const names = new Set<string>()
  for (const item of participantList(raw)) {
    if (item && typeof item === 'object') for (const k of Object.keys(item)) names.add(k)
  }
  return [...names].sort()
}

export function parseWahaParticipants(raw: unknown): WahaGroupParticipant[] {
  const out: WahaGroupParticipant[] = []
  for (const item of participantList(raw)) {
    const id = jidOf(item)
    if (!id) continue
    const rec = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    const role = rec && typeof rec.role === 'string' ? rec.role : null
    out.push({ id, role, phone: rec ? phoneInRecord(rec) : null })
  }
  return out
}

function storeEnabled(session: WahaSessionInfo): boolean {
  return session.config?.noweb?.store?.enabled === true
}

function webhookMatches(session: WahaSessionInfo, opts: EnsureSessionOptions): boolean {
  const hooks = session.config?.webhooks ?? []
  return hooks.some(
    (h) =>
      h.url === opts.webhookUrl &&
      WEBHOOK_EVENTS.every((e) => (h.events ?? []).includes(e)) &&
      (h.customHeaders ?? []).some(
        (c) =>
          c.name?.toLowerCase() === WAHA_WEBHOOK_SECRET_HEADER &&
          c.value === opts.webhookSecret,
      ),
  )
}
