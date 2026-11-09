import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processWahaInbound = vi.fn()
const processWahaOutgoing = vi.fn()
vi.mock('@/lib/whatsapp/waha-inbound', () => ({
  processWahaInbound: (...args: unknown[]) => processWahaInbound(...args),
  processWahaOutgoing: (...args: unknown[]) => processWahaOutgoing(...args),
}))

const processWahaGroupMessage = vi.fn()
vi.mock('@/lib/whatsapp/waha-group-inbound', () => ({
  processWahaGroupMessage: (...args: unknown[]) => processWahaGroupMessage(...args),
}))

const processWahaAck = vi.fn()
vi.mock('@/lib/whatsapp/waha-ack', () => ({
  processWahaAck: (...args: unknown[]) => processWahaAck(...args),
}))

import { POST } from './route'

const URL_ = 'http://localhost/api/whatsapp/waha/webhook'

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const message = {
  event: 'message',
  session: 'sess-1',
  payload: { id: 'm1', from: '628123@c.us', body: 'halo' },
}

describe('WAHA webhook auth', () => {
  const prev = process.env.WAHA_WEBHOOK_SECRET

  beforeEach(() => {
    processWahaInbound.mockReset()
    processWahaOutgoing.mockReset()
    processWahaGroupMessage.mockReset()
    processWahaAck.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.WAHA_WEBHOOK_SECRET
    else process.env.WAHA_WEBHOOK_SECRET = prev
    vi.restoreAllMocks()
  })

  it('fails closed when no secret is configured', async () => {
    delete process.env.WAHA_WEBHOOK_SECRET
    const res = await POST(req(message, { 'x-webhook-secret': 'anything' }))
    expect(res.status).toBe(503)
    expect(processWahaInbound).not.toHaveBeenCalled()
  })

  it('rejects a missing or wrong secret', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    expect((await POST(req(message))).status).toBe(401)
    expect((await POST(req(message, { 'x-webhook-secret': 'nope' }))).status).toBe(401)
    expect(processWahaInbound).not.toHaveBeenCalled()
  })

  it('processes a message that carries the right secret', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    const res = await POST(req(message, { 'x-webhook-secret': 's3cret' }))
    expect(res.status).toBe(200)
    expect(processWahaInbound).toHaveBeenCalledWith({
      sessionName: 'sess-1',
      payload: message.payload,
    })
  })

  it('does not treat our own outbound messages on the plain message event as inbound', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    const res = await POST(
      req({ ...message, payload: { ...message.payload, fromMe: true } }, { 'x-webhook-secret': 's3cret' }),
    )
    expect(await res.json()).toEqual({ status: 'ignored' })
    expect(processWahaInbound).not.toHaveBeenCalled()
    expect(processWahaOutgoing).not.toHaveBeenCalled()
  })

  it('records a message typed on the phone (message.any with fromMe)', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    const body = {
      event: 'message.any',
      session: 'sess-1',
      payload: { id: 'true_628@c.us_ABC', fromMe: true, to: '628123@c.us', body: 'siap' },
    }
    const res = await POST(req(body, { 'x-webhook-secret': 's3cret' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'received' })
    expect(processWahaOutgoing).toHaveBeenCalledWith({ sessionName: 'sess-1', payload: body.payload })
    expect(processWahaInbound).not.toHaveBeenCalled()
  })

  it('still answers 200 when saving a phone-side message fails', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    processWahaOutgoing.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(
      req(
        { event: 'message.any', session: 'sess-1', payload: { id: 'x', fromMe: true, to: '628123@c.us' } },
        { 'x-webhook-secret': 's3cret' },
      ),
    )
    expect(res.status).toBe(200)
  })

  it('does not double-handle an incoming message that arrives as message.any', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    const res = await POST(
      req({ ...message, event: 'message.any' }, { 'x-webhook-secret': 's3cret' }),
    )
    expect(res.status).toBe(200)
    expect(processWahaInbound).toHaveBeenCalledTimes(1)
    expect(processWahaOutgoing).not.toHaveBeenCalled()
  })

  it('routes delivery receipts to the ack handler, not the inbound handler', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    const ack = {
      event: 'message.ack',
      session: 'sess-1',
      payload: { id: 'true_628@c.us_ABC', fromMe: true, ack: 3 },
    }
    const res = await POST(req(ack, { 'x-webhook-secret': 's3cret' }))
    expect(res.status).toBe(200)
    expect(processWahaAck).toHaveBeenCalledWith({ sessionName: 'sess-1', payload: ack.payload })
    expect(processWahaInbound).not.toHaveBeenCalled()
  })

  it('hands a group message to the group handler, never to the inbox', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    const body = {
      ...message,
      payload: { ...message.payload, from: '120363012345678901@g.us', participant: '628123@c.us' },
    }
    const res = await POST(req(body, { 'x-webhook-secret': 's3cret' }))
    expect(await res.json()).toEqual({ status: 'received' })
    expect(processWahaGroupMessage).toHaveBeenCalledWith({ sessionName: 'sess-1', payload: body.payload })
    expect(processWahaInbound).not.toHaveBeenCalled()
    expect(processWahaOutgoing).not.toHaveBeenCalled()
  })

  it('also routes our own message in a group (message.any, fromMe) to the group handler', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    const body = {
      event: 'message.any',
      session: 'sess-1',
      payload: { id: 'x', fromMe: true, to: '120363012345678901@g.us', body: 'ok' },
    }
    await POST(req(body, { 'x-webhook-secret': 's3cret' }))
    expect(processWahaGroupMessage).toHaveBeenCalledTimes(1)
    expect(processWahaOutgoing).not.toHaveBeenCalled()
  })

  it('still answers 200 when saving a group message fails', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    processWahaGroupMessage.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(
      req(
        { ...message, payload: { ...message.payload, from: '120363012345678901@g.us' } },
        { 'x-webhook-secret': 's3cret' },
      ),
    )
    expect(res.status).toBe(200)
  })

  it.each(['status@broadcast', '120363012345678901@newsletter'])(
    'ignores messages from %s',
    async (from) => {
      process.env.WAHA_WEBHOOK_SECRET = 's3cret'
      const res = await POST(
        req({ ...message, payload: { ...message.payload, from } }, { 'x-webhook-secret': 's3cret' }),
      )
      expect(await res.json()).toEqual({ status: 'ignored' })
      expect(processWahaInbound).not.toHaveBeenCalled()
    },
  )
})
