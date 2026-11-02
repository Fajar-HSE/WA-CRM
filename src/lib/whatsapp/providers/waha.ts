// ============================================================
// WAHA (WhatsApp HTTP API) adapter.
//
// Implements the WhatsAppProvider contract against WAHA's REST API.
// Requires a running WAHA instance (Docker). Configure via env:
//   WAHA_BASE_URL, WAHA_API_KEY
// or per-config fields waha_base_url / waha_session_name.
// ============================================================

import type { WhatsAppProvider, WhatsAppProviderCredentials, WhatsAppSendResult, WhatsAppMediaInfo } from './provider'

export class WahaHttpError extends Error {
  constructor(message: string, public status: number, public body?: unknown) {
    super(message)
    this.name = 'WahaHttpError'
  }
}

function toChatId(to: string): string {
  const v = to.trim()
  if (v.includes('@')) return v
  const digits = v.replace(/[^\d]/g, '')
  return `${digits}@c.us`
}

function guessMime(kind: string, provided?: string): string {
  if (provided) return provided
  switch (kind) {
    case 'image': return 'image/jpeg'
    case 'video': return 'video/mp4'
    case 'audio': return 'audio/ogg; codecs=opus'
    default: return 'application/octet-stream'
  }
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

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
        ...(init.headers || {}),
      },
    })
    const text = await res.text()
    let body: any = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    if (!res.ok) {
      throw new WahaHttpError(`WAHA ${path} failed: ${res.status} ${res.statusText}`, res.status, body)
    }
    return body
  }

  async sendText(args: { to: string; text: string; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    const body: any = {
      session: this.sessionName,
      chatId: toChatId(args.to),
      text: args.text,
    }
    if (args.contextMessageId) body.reply_to = args.contextMessageId
    const res = await this.request('/api/sendText', { method: 'POST', body: JSON.stringify(body) })
    return { messageId: res?.id ?? res?.messageId ?? '' }
  }

  async sendMedia(args: { to: string; kind: 'image' | 'video' | 'document' | 'audio'; link: string; caption?: string; filename?: string; mimeType?: string; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    const chatId = toChatId(args.to)
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

    const body: any = {
      session: this.sessionName,
      chatId,
      file,
    }
    if (args.caption) body.caption = args.caption
    if (args.contextMessageId) body.reply_to = args.contextMessageId
    if (args.kind === 'audio') body.convert = false

    const res = await this.request(path, { method: 'POST', body: JSON.stringify(body) })
    return { messageId: res?.id ?? res?.messageId ?? '' }
  }

  async sendTemplate(args: { to: string; templateName: string; language: string; params?: string[]; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    // WAHA has no Meta template concept; send as plain text fallback.
    const text = args.params && args.params.length
      ? `${args.templateName}: ${args.params.join(' ')}`
      : args.templateName
    return this.sendText({ to: args.to, text, contextMessageId: args.contextMessageId })
  }

  async sendInteractiveButtons(args: { to: string; bodyText: string; headerText?: string; footerText?: string; buttons: { id: string; title: string }[]; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    // WAHA supports buttons via /api/sendButtons (Plus). Fallback to text list.
    const lines = [args.bodyText, '', ...args.buttons.map((b, i) => `${i + 1}. ${b.title}`)]
    return this.sendText({ to: args.to, text: lines.join('\n'), contextMessageId: args.contextMessageId })
  }

  async sendInteractiveList(args: { to: string; bodyText: string; buttonLabel: string; headerText?: string; footerText?: string; sections: { title: string; rows: { id: string; title: string; description?: string }[] }[]; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    const lines = [args.bodyText, '']
    for (const s of args.sections) {
      lines.push(`[${s.title}]`)
      for (const r of s.rows) lines.push(`- ${r.title}${r.description ? `: ${r.description}` : ''}`)
    }
    return this.sendText({ to: args.to, text: lines.join('\n'), contextMessageId: args.contextMessageId })
  }

  async getMediaUrl(args: { mediaId: string }): Promise<WhatsAppMediaInfo> {
    // For WAHA, mediaId is often already a URL.
    return { url: args.mediaId, mimeType: 'application/octet-stream', fileSize: 0 }
  }

  // ---- Session management ----
  async startSession(sessionName: string): Promise<void> {
    await this.request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: sessionName || this.sessionName, config: { webhooks: [] } }),
    })
  }

  async stopSession(sessionName: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionName || this.sessionName)}/stop`, { method: 'POST' })
  }

  async getSessionStatus(sessionName: string): Promise<string> {
    const res = await this.request(`/api/sessions/${encodeURIComponent(sessionName || this.sessionName)}`)
    return res?.status ?? 'UNKNOWN'
  }

  async getQrCode(sessionName: string): Promise<string | null> {
    try {
      const res = await this.request(`/api/${encodeURIComponent(sessionName || this.sessionName)}/auth/qr`)
      return res?.qr ?? res?.value ?? null
    } catch {
      return null
    }
  }

  async logoutSession(sessionName: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionName || this.sessionName)}/logout`, { method: 'POST' })
  }
}
