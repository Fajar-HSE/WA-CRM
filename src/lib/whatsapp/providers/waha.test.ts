import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WahaWhatsAppProvider } from './waha'

describe('WahaWhatsAppProvider', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn() as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends text via /api/sendText', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'msg-1' }),
    })

    const p = new WahaWhatsAppProvider({
      sessionName: 'sess-1',
      baseUrl: 'http://waha:3000',
      apiKey: 'secret',
    })

    const res = await p.sendText({ to: '+628123456789', text: 'hello' })
    expect(res.messageId).toBe('msg-1')

    const call = (globalThis.fetch as any).mock.calls[0]
    expect(call[0]).toBe('http://waha:3000/api/sendText')
    const body = JSON.parse(call[1].body)
    expect(body.session).toBe('sess-1')
    expect(body.chatId).toBe('628123456789@c.us')
    expect(body.text).toBe('hello')
    expect(call[1].headers['X-Api-Key']).toBe('secret')
  })

  it('throws on non-2xx', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ error: 'bad key' }),
    })

    const p = new WahaWhatsAppProvider({
      sessionName: 'sess-1',
      baseUrl: 'http://waha:3000',
      apiKey: 'secret',
    })

    await expect(p.sendText({ to: '6281@c.us', text: 'hi' })).rejects.toThrow()
  })
})
