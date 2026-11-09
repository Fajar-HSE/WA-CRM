import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  role: vi.fn(),
  upserts: [] as unknown[],
  error: null as unknown,
  provider: {} as unknown,
}))

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
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {
        upsert: (row: unknown, opts: unknown) => {
          h.upserts.push({ row, opts })
          return chain
        },
        select: () => chain,
        single: async () =>
          h.error
            ? { data: null, error: h.error }
            : { data: { id: 'g-1', jid: '1@g.us', subject: 'X', monitored: true }, error: null },
      }
      return chain
    },
  }),
}))

import { POST } from './route'

const req = (body: unknown) =>
  new Request('http://localhost/api/whatsapp/groups/monitor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/whatsapp/groups/monitor', () => {
  beforeEach(() => {
    h.upserts = []
    h.error = null
    h.provider = {}
    h.role.mockReset()
    h.role.mockResolvedValue({ supabase: {}, accountId: 'acct-1', userId: 'u-1' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('requires the admin role', async () => {
    await POST(req({ jid: '1@g.us', enabled: true }))
    expect(h.role).toHaveBeenCalledWith('admin')
  })

  it('turns monitoring on for the caller\'s own account', async () => {
    const res = await POST(req({ jid: '1@g.us', subject: '  Peserta K3 ', enabled: true }))
    expect(res.status).toBe(200)
    expect(h.upserts[0]).toEqual({
      row: { account_id: 'acct-1', jid: '1@g.us', monitored: true, subject: 'Peserta K3' },
      opts: { onConflict: 'account_id,jid' },
    })
  })

  it('turns monitoring off without touching the saved name', async () => {
    await POST(req({ jid: '1@g.us', enabled: false }))
    expect(h.upserts[0]).toMatchObject({ row: { monitored: false } })
    expect((h.upserts[0] as { row: Record<string, unknown> }).row).not.toHaveProperty('subject')
  })

  it('rejects ids that are not groups and non-boolean flags', async () => {
    expect((await POST(req({ jid: '628@c.us', enabled: true }))).status).toBe(400)
    expect((await POST(req({ jid: '1@g.us', enabled: 'yes' }))).status).toBe(400)
    expect((await POST(req(null))).status).toBe(400)
    expect(h.upserts).toEqual([])
  })

  it('refuses accounts that are not on WAHA', async () => {
    h.provider = null
    expect((await POST(req({ jid: '1@g.us', enabled: true }))).status).toBe(400)
    expect(h.upserts).toEqual([])
  })

  it('reports a failed save', async () => {
    h.error = { message: 'nope' }
    expect((await POST(req({ jid: '1@g.us', enabled: true }))).status).toBe(500)
  })
})
