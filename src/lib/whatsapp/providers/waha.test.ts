import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  WahaHttpError,
  WahaNumberNotFoundError,
  WahaStoreDisabledError,
  WahaTemplateVariableError,
  WahaWhatsAppProvider,
  messageIdOf,
} from './waha'

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

    // call 0 is the number check; its reply has no `numberExists`, so the
    // provider falls back to the plain <digits>@c.us form.
    const call = callAt(1)
    expect(call.url).toBe('http://waha:3000/api/sendText')
    expect(call.body.session).toBe('sess-1')
    expect(call.body.chatId).toBe('628123456789@c.us')
    expect(call.body.text).toBe('hello')
    expect(call.headers['X-Api-Key']).toBe('secret')
  })

  describe('chat id resolution', () => {
    it('uses the chat id WAHA reports for a registered number', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ numberExists: true, chatId: '628123456789@c.us' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'm1' }))
      await makeProvider().sendText({ to: '+628123456789', text: 'hi' })
      expect(callAt(0).url).toBe(
        'http://waha:3000/api/contacts/check-exists?phone=628123456789&session=sess-1',
      )
      expect(callAt(1).body.chatId).toBe('628123456789@c.us')
    })

    it('fails loudly for a number that is not on WhatsApp', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ numberExists: false }))
      await expect(makeProvider().sendText({ to: '628123456789', text: 'hi' })).rejects.toBeInstanceOf(
        WahaNumberNotFoundError,
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('addresses a lid-length number as @lid instead of a phone', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ numberExists: false }))
        .mockResolvedValueOnce(jsonResponse({ id: 'm1' }))
      await makeProvider().sendText({ to: '30601675599946', text: 'hi' })
      expect(callAt(1).body.chatId).toBe('30601675599946@lid')
    })

    it('does not check ids that already carry a suffix', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'm1' }))
      await makeProvider().sendText({ to: '30601675599946@lid', text: 'hi' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(callAt(0).body.chatId).toBe('30601675599946@lid')
    })

    it('falls back to @c.us when the check endpoint is unavailable', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 404))
        .mockResolvedValueOnce(jsonResponse({ id: 'm1' }))
      await makeProvider().sendText({ to: '628123456789', text: 'hi' })
      expect(callAt(1).body.chatId).toBe('628123456789@c.us')
    })
  })

  describe('getPhoneForLid', () => {
    it('returns the phone WAHA maps a lid to', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ lid: '30601675599946@lid', pn: '628123456789@c.us' }))
      expect(await makeProvider().getPhoneForLid('30601675599946@lid')).toBe('628123456789')
      expect(callAt(0).url).toBe(
        'http://waha:3000/api/sess-1/lids/30601675599946%40lid',
      )
    })

    it('returns null when WAHA does not know it', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ lid: 'x@lid', pn: null }))
      expect(await makeProvider().getPhoneForLid('30601675599946')).toBeNull()
      fetchMock.mockResolvedValue(jsonResponse({}, 404))
      expect(await makeProvider().getPhoneForLid('30601675599946')).toBeNull()
    })
  })

  it('reads a serialized message id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: { _serialized: 'true_1@c.us_ABC' } }))
    const res = await makeProvider().sendText({ to: '6281', text: 'hi' })
    expect(res.messageId).toBe('true_1@c.us_ABC')
  })

  it('reads the message id from every known response shape', () => {
    expect(messageIdOf({ id: 'true_1@c.us_A' })).toBe('true_1@c.us_A')
    expect(messageIdOf({ id: { _serialized: 'true_1@c.us_B' } })).toBe('true_1@c.us_B')
    expect(messageIdOf({ id: { fromMe: true, remote: '1@c.us', id: 'C' } })).toBe('true_1@c.us_C')
    expect(messageIdOf({ _data: { id: { _serialized: 'true_1@c.us_D' } } })).toBe('true_1@c.us_D')
    expect(messageIdOf({ key: { fromMe: true, remoteJid: '1@s.whatsapp.net', id: 'E' } })).toBe(
      'true_1@s.whatsapp.net_E',
    )
    expect(messageIdOf({})).toBe('')
    expect(messageIdOf(null)).toBe('')
  })

  it('never returns an empty id, so two sends cannot collide in the database', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }))
    const p = makeProvider()
    const a = await p.sendText({ to: '628123456789@c.us', text: 'one' })
    const b = await p.sendText({ to: '628123456789@c.us', text: 'two' })
    expect(a.messageId).toMatch(/^waha-local-/)
    expect(b.messageId).toMatch(/^waha-local-/)
    expect(a.messageId).not.toBe(b.messageId)
  })

  describe('sendTemplate', () => {
    const row = { body_text: 'Halo {{1}}, pesanan {{2}} sudah dikirim.', footer_text: 'Terima kasih' }

    async function sentText(args: Parameters<WahaWhatsAppProvider['sendTemplate']>[0]) {
      fetchMock.mockResolvedValue(jsonResponse({ id: 'm1' }))
      await makeProvider().sendTemplate(args)
      const send = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/sendText'))!
      return JSON.parse((send[1] as RequestInit).body as string).text as string
    }

    it('sends the template body with its values filled in, plus the footer', async () => {
      const text = await sentText({
        to: '628123456789@c.us',
        templateName: 'order',
        language: 'id',
        template: row,
        params: ['Sari', 'A-12'],
      })
      expect(text).toBe('Halo Sari, pesanan A-12 sudah dikirim.\n\nTerima kasih')
    })

    it('reads values from the structured message params too', async () => {
      const text = await sentText({
        to: '628123456789@c.us',
        templateName: 'order',
        language: 'id',
        template: { body_text: 'Halo {{1}}' },
        messageParams: { body: ['Budi'] },
      })
      expect(text).toBe('Halo Budi')
    })

    it('refuses to send a template whose placeholders were not all filled in', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 'm1' }))
      const err = await makeProvider()
        .sendTemplate({
          to: '628123456789@c.us',
          templateName: 'order',
          language: 'id',
          template: row,
          params: ['Sari'],
        })
        .catch((e) => e)
      expect(err).toBeInstanceOf(WahaTemplateVariableError)
      expect(err.missing).toEqual(['2'])
      expect(err.message).toContain('{{2}}')
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/api/sendText'))).toBe(false)
    })

    it('refuses a template sent with no values at all', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 'm1' }))
      await expect(
        makeProvider().sendTemplate({
          to: '628123456789@c.us',
          templateName: 'hello',
          language: 'id',
          template: { body_text: 'Halo {{1}}, terima kasih telah menghubungi kami.' },
        }),
      ).rejects.toBeInstanceOf(WahaTemplateVariableError)
    })

    it('still sends a template that has no placeholders without any values', async () => {
      const text = await sentText({
        to: '628123456789@c.us',
        templateName: 'hello',
        language: 'id',
        template: { body_text: 'Terima kasih telah menghubungi kami.' },
      })
      expect(text).toBe('Terima kasih telah menghubungi kami.')
    })

    it('falls back to the name and values when no template row is given', async () => {
      const text = await sentText({
        to: '628123456789@c.us',
        templateName: 'order',
        language: 'id',
        params: ['Sari', 'A-12'],
      })
      expect(text).toBe('order: Sari A-12')
    })
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
        events: ['message', 'message.any', 'message.ack'],
        customHeaders: [{ name: 'x-webhook-secret', value: 's3' }],
      })
      expect(create.body.config.noweb).toEqual({ store: { enabled: true, fullSync: false } })
    })

    it('leaves a running session alone when its webhook is already correct', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          name: 'sess-1',
          status: 'WORKING',
          config: {
            noweb: { store: { enabled: true, fullSync: false } },
            webhooks: [
              {
                url: opts.webhookUrl,
                events: ['message', 'message.any', 'message.ack'],
                customHeaders: [{ name: 'X-Webhook-Secret', value: 's3' }],
              },
            ],
          },
        }),
      )
      await makeProvider().ensureSession(opts)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('updates a session that does not yet have the message.any event or the store', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            name: 'sess-1',
            status: 'WORKING',
            config: {
              webhooks: [
                {
                  url: opts.webhookUrl,
                  events: ['message', 'message.ack'],
                  customHeaders: [{ name: 'X-Webhook-Secret', value: 's3' }],
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({}))
      await makeProvider().ensureSession(opts)
      const put = callAt(1)
      expect(put.init.method).toBe('PUT')
      expect(put.body.config.webhooks[0].events).toContain('message.any')
      expect(put.body.config.noweb.store.enabled).toBe(true)
    })

    it('updates a session whose webhook is right but whose store is off', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            name: 'sess-1',
            status: 'WORKING',
            config: {
              webhooks: [
                {
                  url: opts.webhookUrl,
                  events: ['message', 'message.any', 'message.ack'],
                  customHeaders: [{ name: 'X-Webhook-Secret', value: 's3' }],
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({}))
      await makeProvider().ensureSession(opts)
      expect(callAt(1).init.method).toBe('PUT')
    })

    it('updates a session whose webhook lacks the ack event', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            name: 'sess-1',
            status: 'WORKING',
            config: {
              webhooks: [
                {
                  url: opts.webhookUrl,
                  events: ['message'],
                  customHeaders: [{ name: 'X-Webhook-Secret', value: 's3' }],
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({}))
      await makeProvider().ensureSession(opts)
      expect(callAt(1).init.method).toBe('PUT')
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

  describe('listChatMessages', () => {
    it('asks WAHA for the chat messages without downloading media', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ id: 'true_x@c.us_A', fromMe: true, body: 'hi', timestamp: 1 }]),
      )
      const res = await makeProvider().listChatMessages('628123456789@c.us', { limit: 50 })
      expect(res).toHaveLength(1)
      const c = callAt(0)
      expect(c.url).toContain('/api/sess-1/chats/628123456789%40c.us/messages?')
      expect(c.url).toContain('limit=50')
      expect(c.url).toContain('downloadMedia=false')
    })

    it('caps the page size', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]))
      await makeProvider().listChatMessages('628123456789@c.us', { limit: 9999 })
      expect(callAt(0).url).toContain('limit=200')
    })

    it('reports a disabled store distinctly', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ message: 'Enable NOWEB store to use this method' }, 400),
      )
      await expect(
        makeProvider().listChatMessages('628123456789@c.us'),
      ).rejects.toBeInstanceOf(WahaStoreDisabledError)
    })

    it('passes other WAHA errors through', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))
      await expect(makeProvider().listChatMessages('628123456789@c.us')).rejects.toBeInstanceOf(
        WahaHttpError,
      )
    })

    it('returns an empty list for a non-array answer', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
      expect(await makeProvider().listChatMessages('628123456789@c.us')).toEqual([])
    })
  })

  describe('groups', () => {
    it('lists the groups the number belongs to', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ id: '1@g.us', subject: 'Peserta K3', participants: [{}, {}] }, { id: '628@c.us' }]),
      )
      const res = await makeProvider().listGroups()
      expect(res).toEqual([{ id: '1@g.us', subject: 'Peserta K3', size: 2 }])
      expect(callAt(0).url).toContain('/api/sess-1/groups?')
    })

    it('reads one group by id and answers null when WAHA cannot', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1@g.us', subject: 'Alumni' }))
      expect(await makeProvider().getGroup('1@g.us')).toMatchObject({ subject: 'Alumni' })
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'nope' }, 500))
      expect(await makeProvider().getGroup('1@g.us')).toBeNull()
    })

    it('reads members from the v2 endpoint', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ id: '628111@c.us', role: 'admin' }, { id: '99@lid', role: 'participant' }]),
      )
      const res = await makeProvider().listGroupParticipants('1@g.us')
      expect(res).toEqual([
        { id: '628111@c.us', role: 'admin', phone: null },
        { id: '99@lid', role: 'participant', phone: null },
      ])
      expect(callAt(0).url).toContain('/groups/1%40g.us/participants/v2')
    })

    it('falls back to the original members endpoint when v2 does not exist', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))
        .mockResolvedValueOnce(jsonResponse([{ id: '628111@c.us' }]))
      const res = await makeProvider().listGroupParticipants('1@g.us')
      expect(res).toHaveLength(1)
      expect(callAt(1).url).toMatch(/participants$/)
    })

    it('does not hide other member-list errors', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))
      await expect(makeProvider().listGroupParticipants('1@g.us')).rejects.toBeInstanceOf(WahaHttpError)
    })

    it('fills in a hidden member\'s number from the group record', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse([{ id: '99@lid', role: 'participant' }]))
        .mockResolvedValueOnce(
          jsonResponse({
            id: '1@g.us',
            participants: [{ id: '99@lid', phoneNumber: '6281234567890@s.whatsapp.net', admin: null }],
          }),
        )
      const d = await makeProvider().listGroupParticipantsDetailed('1@g.us')
      expect(d.participants[0].phone).toBe('6281234567890')
      expect(d.groupFallback).toBe('used')
      expect(d.fields).toEqual(expect.arrayContaining(['id', 'role', 'group.phoneNumber']))
      expect(callAt(1).url).toMatch(/\/groups\/1%40g\.us$/)
    })

    it('does not read the group record when every number is already known', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: '628111@c.us', role: 'admin' }]))
      const d = await makeProvider().listGroupParticipantsDetailed('1@g.us')
      expect(d.groupFallback).toBe('not_needed')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('keeps the members when the group record cannot be read', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse([{ id: '99@lid', role: null }]))
        .mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))
      const d = await makeProvider().listGroupParticipantsDetailed('1@g.us')
      expect(d.participants).toHaveLength(1)
      expect(d.groupFallback).toBe('failed')
    })

    it('reports why a LID lookup is empty', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ lid: '99@lid', pn: null }))
      expect(await makeProvider().getLidMapping('99@lid')).toEqual({ phone: null, error: null })
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'x' }, 422))
      expect(await makeProvider().getLidMapping('99@lid')).toEqual({ phone: null, error: 'HTTP 422' })
      fetchMock.mockResolvedValueOnce(jsonResponse({ lid: '99@lid', pn: '6281234567890@c.us' }))
      expect((await makeProvider().getLidMapping('99@lid')).phone).toBe('6281234567890')
    })
  })
})
