import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  role: vi.fn(),
  provider: null as unknown,
  saved: [] as unknown[],
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

import { WahaHttpError } from '@/lib/whatsapp/providers/waha'
import { GET } from './route'

describe('GET /api/whatsapp/groups', () => {
  beforeEach(() => {
    h.saved = []
    h.role.mockReset()
    h.role.mockResolvedValue({
      supabase: {
        from: () => {
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: async () => ({ data: h.saved, error: null }),
          }
          return chain
        },
      },
      accountId: 'acct-1',
      userId: 'u-1',
    })
    h.provider = { listGroups: async () => [{ id: '1@g.us', subject: 'Peserta K3', size: 40 }] }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('requires the admin role', async () => {
    await GET()
    expect(h.role).toHaveBeenCalledWith('admin')
  })

  it('merges live groups with what was saved, and keeps groups the number left', async () => {
    h.saved = [
      { id: 'r1', jid: '1@g.us', subject: null, monitored: true, last_message_at: '2026-11-09T01:00:00Z', last_message_text: 'hi' },
      { id: 'r2', jid: '2@g.us', subject: 'Lama', monitored: true, last_message_at: null, last_message_text: null },
    ]
    const body = await (await GET()).json()
    expect(body.groups).toEqual([
      {
        jid: '1@g.us',
        subject: 'Peserta K3',
        size: 40,
        monitored: true,
        last_message_at: '2026-11-09T01:00:00Z',
        last_message_text: 'hi',
        left: false,
      },
      {
        jid: '2@g.us',
        subject: 'Lama',
        size: null,
        monitored: true,
        last_message_at: null,
        last_message_text: null,
        left: true,
      },
    ])
  })

  it('shows a live group as not monitored until an admin turns it on', async () => {
    const body = await (await GET()).json()
    expect(body.groups[0].monitored).toBe(false)
  })

  it('refuses accounts that are not on WAHA', async () => {
    h.provider = null
    expect((await GET()).status).toBe(400)
  })

  it('maps a WAHA failure to 502', async () => {
    h.provider = {
      listGroups: async () => {
        throw new WahaHttpError('boom', 500)
      },
    }
    expect((await GET()).status).toBe(502)
  })
})
