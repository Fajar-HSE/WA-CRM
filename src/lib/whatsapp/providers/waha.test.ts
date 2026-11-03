import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WahaWhatsAppProvider } from './waha'

type FetchMock = ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    text: async () => JSON.stringify(body),
  }
}

function makeProvider() {
  return new WahaWhatsAppProvider({
    sessionName: 'sess-1',
    baseUrl: 'http://waha:3000',
    apiKey: 'secret',
  })
}

describe('WahaWhatsAppProvider', () => {
  const originalFetch = globalThis.fetch
  let fetchMock: FetchMock

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function callAt(i: number) {
    const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
    return {
      url,
      init,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: init.headers as Record<string, string>,
    }
  }

  it('sends text via /api/sendText', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'msg-1' }))
    const res = await makeProvider().sendText({ to: '+628123456789', text: 'hello' })
    expect(res.messageId).toBe('msg-1')

    const call = callAt(0)
    expect(call.url).toBe('http://waha:3000/api/sendText')
    expect(call.body.session).toBe('sess-1')
    expect(call.body.chatId).toBe('628123456789@c.us')
    expect(call.body.text).toBe('hello')
    expect(call.headers['X-Api-Key']).toBe('secret')
  })

  it('reads a serialized message id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: { _serialized: 'true_1@c.us_ABC' } }))
    const res = await makeProvider().sendText({ to: '6281', text: 'hi' })
    expect(res.messageId).toBe('true_1@c.us_ABC')
  })

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad key' }, 401))
    await expect(makeProvider().sendText({ to: '6281@c.us', text: 'hi' })).rejects.toThrow()
  })

  it('returns the QR code as a data URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mimetype: 'image/png', data: 'QUJD' }))
    const qr = await makeProvider().getQrCode('sess-1')
    expect(qr).toBe('data:image/png;base64,QUJD')
    expect(callAt(0).url).toBe('http://waha:3000/api/sess-1/auth/qr')
    expect(callAt(0).headers.Accept).toBe('application/json')
  })

  it('returns null when no QR is available', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404))
    expect(await makeProvider().getQrCode('sess-1')).toBeNull()
  })

  describe('ensureSession', () => {
    const opts = { webhookUrl: 'http://app:3000/api/whatsapp/waha/webhook', webhookSecret: 's3' }

    it('creates and starts a missing session with the webhook attached', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))
        .mockResolvedValueOnce(jsonResponse({ name: 'sess-1' }, 201))
      await makeProvider().ensureSession(opts)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      const create = callAt(1)
      expect(create.url).toBe('http://waha:3000/api/sessions')
      expect(create.init.method).toBe('POST')
      expect(create.body.name).toBe('sess-1')
      expect(create.body.start).toBe(true)
      expect(create.body.config.webhooks[0]).toEqual({
        url: opts.webhookUrl,
        events: ['message'],
        customHeaders: [{ name: 'x-webhook-secret', value: 's3' }],
      })
    })

    it('leaves a running session alone when its webhook is already correct', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          name: 'sess-1',
          status: 'WORKING',
          config: {
            webhooks: [
              {
                url: opts.webhookUrl,
                customHeaders: [{ name: 'X-Webhook-Secret', value: 's3' }],
              },
            ],
          },
        }),
      )
      await makeProvider().ensureSession(opts)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('updates the webhook of an existing session and starts it if stopped', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ name: 'sess-1', status: 'STOPPED', config: { webhooks: [] } }))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({}))
      await makeProvider().ensureSession(opts)

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(callAt(1).init.method).toBe('PUT')
      expect(callAt(2).url).toBe('http://waha:3000/api/sessions/sess-1/start')
    })
  })
})
