import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ role: vi.fn(), provider: null as unknown }))

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => h.role(...a),
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String(err) }), { status: 403 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('{}', { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/whatsapp/waha-account', () => ({ loadWahaProvider: async () => h.provider }))

import { WahaHttpError } from '@/lib/whatsapp/providers/waha'
import { GET } from './route'

const req = (jid: string | null) =>
  new Request(`http://localhost/api/whatsapp/groups/members${jid === null ? '' : `?jid=${encodeURIComponent(jid)}`}`)

describe('GET /api/whatsapp/groups/members', () => {
  beforeEach(() => {
    h.role.mockReset()
    h.role.mockResolvedValue({ supabase: {}, accountId: 'acct-1', userId: 'u-1' })
    h.provider = {
      listGroupParticipants: async () => [
        { id: '6281111111111@c.us', role: 'superadmin' },
        { id: '99@lid', role: 'participant' },
      ],
      getPhoneForLid: async () => null,
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('requires the admin role', async () => {
    await GET(req('1@g.us'))
    expect(h.role).toHaveBeenCalledWith('admin')
  })

  it('returns members with numbers and counts, without saving anything', async () => {
    const body = await (await GET(req('1@g.us'))).json()
    expect(body).toEqual({
      members: [
        { id: '6281111111111@c.us', phone: '6281111111111', is_admin: true },
        { id: '99@lid', phone: null, is_admin: false },
      ],
      total: 2,
      unresolved: 1,
      truncated: false,
    })
  })

  it('rejects a missing or non-group id', async () => {
    expect((await GET(req(null))).status).toBe(400)
    expect((await GET(req('628@c.us'))).status).toBe(400)
  })

  it('refuses accounts that are not on WAHA', async () => {
    h.provider = null
    expect((await GET(req('1@g.us'))).status).toBe(400)
  })

  it('maps a WAHA failure to 502', async () => {
    h.provider = {
      listGroupParticipants: async () => {
        throw new WahaHttpError('boom', 500)
      },
      getPhoneForLid: async () => null,
    }
    expect((await GET(req('1@g.us'))).status).toBe(502)
  })
})
