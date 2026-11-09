import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ role: vi.fn(), grab: vi.fn() }))

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => h.role(...a),
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String(err) }), { status: 403 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('{}', { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ tag: 'admin' }) }))
vi.mock('@/lib/whatsapp/waha-groups', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  grabMembersToContacts: (...a: unknown[]) => h.grab(...a),
}))

import { POST } from './route'

const req = (body: unknown) =>
  new Request('http://localhost/api/whatsapp/groups/grab', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/whatsapp/groups/grab', () => {
  beforeEach(() => {
    h.role.mockReset()
    h.role.mockResolvedValue({ accountId: 'acct-1', userId: 'u-1' })
    h.grab.mockReset()
    h.grab.mockResolvedValue({ created: 1, existing: 0, tagged: 1, invalid: 0, tagName: 'Peserta K3' })
  })

  it('requires the admin role', async () => {
    await POST(req({ jid: '1@g.us', group_name: 'X', members: [{ phone: '6281111111111' }] }))
    expect(h.role).toHaveBeenCalledWith('admin')
  })

  it('saves the chosen members for the caller\'s own account', async () => {
    const res = await POST(
      req({
        jid: '1@g.us',
        group_name: 'Peserta K3',
        members: [{ phone: '6281111111111', name: 'Budi' }, { phone: 5 }, 'junk'],
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ created: 1, tagName: 'Peserta K3' })
    expect(h.grab).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        userId: 'u-1',
        groupName: 'Peserta K3',
        members: [{ phone: '6281111111111', name: 'Budi' }],
      }),
    )
  })

  it('rejects bad input and oversize batches', async () => {
    expect((await POST(req({ jid: '628@c.us', members: [{ phone: '1' }] }))).status).toBe(400)
    expect((await POST(req({ jid: '1@g.us', members: 'x' }))).status).toBe(400)
    expect((await POST(req({ jid: '1@g.us', members: [] }))).status).toBe(400)
    const many = Array.from({ length: 151 }, () => ({ phone: '6281111111111' }))
    expect((await POST(req({ jid: '1@g.us', members: many }))).status).toBe(400)
    expect(h.grab).not.toHaveBeenCalled()
  })
})
