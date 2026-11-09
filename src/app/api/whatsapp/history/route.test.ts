import { beforeEach, describe, expect, it, vi } from 'vitest'

const CONV = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  role: vi.fn(),
  importChatHistory: vi.fn(),
  provider: null as unknown,
  visible: true as boolean,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => h.role(...a),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 403 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ tag: 'admin' }) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('{}', { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/whatsapp/providers', () => ({ createWhatsAppProvider: () => h.provider }))
vi.mock('@/lib/whatsapp/waha-history', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  importChatHistory: (...a: unknown[]) => h.importChatHistory(...a),
}))

import { WahaHttpError, WahaStoreDisabledError, WahaWhatsAppProvider } from '@/lib/whatsapp/providers/waha'
import { HistoryImportError } from '@/lib/whatsapp/waha-history'
import { POST } from './route'

function supabase() {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: table === 'whatsapp_config' ? { id: 'cfg', provider: 'waha' } : h.visible ? { id: CONV } : null,
          error: null,
        }),
      }
      return chain
    },
  }
}

function req(body: unknown) {
  return new Request('http://localhost/api/whatsapp/history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/whatsapp/history', () => {
  beforeEach(() => {
    h.role.mockReset()
    h.role.mockResolvedValue({ supabase: supabase(), accountId: 'acct-1', userId: 'u-1' })
    h.importChatHistory.mockReset()
    h.provider = new WahaWhatsAppProvider({ sessionName: 's', baseUrl: 'http://waha', apiKey: 'k' })
    h.visible = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('requires at least the agent role', async () => {
    h.importChatHistory.mockResolvedValue({ fetched: 0, imported: 0, skipped: 0, hasMore: false })
    await POST(req({ conversation_id: CONV }))
    expect(h.role).toHaveBeenCalledWith('agent')
  })

  it('rejects a conversation id that is not a uuid', async () => {
    const res = await POST(req({ conversation_id: 'nope' }))
    expect(res.status).toBe(400)
    expect(h.importChatHistory).not.toHaveBeenCalled()
  })

  it('refuses accounts that are not on WAHA', async () => {
    h.provider = { name: 'meta' }
    const res = await POST(req({ conversation_id: CONV }))
    expect(res.status).toBe(400)
    expect(h.importChatHistory).not.toHaveBeenCalled()
  })

  it('404s when the caller cannot see the conversation', async () => {
    h.visible = false
    const res = await POST(req({ conversation_id: CONV }))
    expect(res.status).toBe(404)
    expect(h.importChatHistory).not.toHaveBeenCalled()
  })

  it('returns the counts and the next offset', async () => {
    h.importChatHistory.mockResolvedValue({ fetched: 100, imported: 40, skipped: 60, hasMore: true })
    const res = await POST(req({ conversation_id: CONV, offset: 100 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      fetched: 100,
      imported: 40,
      skipped: 60,
      has_more: true,
      next_offset: 200,
    })
    expect(h.importChatHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV, accountId: 'acct-1', offset: 100, limit: 100 }),
    )
  })

  it('ignores a bad offset', async () => {
    h.importChatHistory.mockResolvedValue({ fetched: 0, imported: 0, skipped: 0, hasMore: false })
    await POST(req({ conversation_id: CONV, offset: -5 }))
    expect(h.importChatHistory).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }))
  })

  it('says so when the WAHA store is off', async () => {
    h.importChatHistory.mockRejectedValue(new WahaStoreDisabledError())
    const res = await POST(req({ conversation_id: CONV }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('history_store_disabled')
  })

  it('maps WAHA failures to 502 and import errors to their status', async () => {
    h.importChatHistory.mockRejectedValueOnce(new WahaHttpError('boom', 500))
    expect((await POST(req({ conversation_id: CONV }))).status).toBe(502)
    h.importChatHistory.mockRejectedValueOnce(new HistoryImportError('no phone', 400))
    expect((await POST(req({ conversation_id: CONV }))).status).toBe(400)
  })
})
