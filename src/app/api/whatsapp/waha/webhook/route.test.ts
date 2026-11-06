import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processWahaInbound = vi.fn()
vi.mock('@/lib/whatsapp/waha-inbound', () => ({
  processWahaInbound: (...args: unknown[]) => processWahaInbound(...args),
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

  it('ignores our own outbound messages', async () => {
    process.env.WAHA_WEBHOOK_SECRET = 's3cret'
    const res = await POST(
      req({ ...message, payload: { ...message.payload, fromMe: true } }, { 'x-webhook-secret': 's3cret' }),
    )
    expect(await res.json()).toEqual({ status: 'ignored' })
    expect(processWahaInbound).not.toHaveBeenCalled()
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

  it.each(['status@broadcast', '120363012345678901@g.us', '120363012345678901@newsletter'])(
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
