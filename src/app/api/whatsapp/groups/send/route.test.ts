import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  role: vi.fn(),
  allowed: true,
  group: null as unknown,
  provider: null as unknown,
  sendText: vi.fn(),
  upserts: [] as unknown[],
  upsertRows: [{ id: 'm-1' }] as unknown[] | null,
  upsertError: null as unknown,
  groupUpdates: [] as unknown[],
  groupLookups: [] as unknown[],
  logged: [] as unknown[],
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => h.role(...a),
  toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: String(err) }), { status: 403 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: h.allowed }),
  rateLimitResponse: () => new Response('{}', { status: 429 }),
  RATE_LIMITS: { send: {} },
}))
vi.mock('@/lib/logging/error-log', () => ({
  logError: async (...a: unknown[]) => {
    h.logged.push(a)
  },
}))
vi.mock('@/lib/whatsapp/waha-account', () => ({ loadWahaProvider: async () => h.provider }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        upsert: (row: unknown, opts: unknown) => {
          h.upserts.push({ table, row, opts })
          return chain
        },
        select: async () => ({ data: h.upsertRows, error: h.upsertError }),
        update: (patch: unknown) => {
          h.groupUpdates.push({ table, patch })
          return { eq: async () => ({ error: null }) }
        },
      }
      return chain
    },
  }),
}))

import { MAX_GROUP_TEXT } from '@/lib/groups/limits'
import { POST } from './route'

/** The caller's own client: only the group lookup is used. */
function callerClient() {
  return {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          h.groupLookups.push([col, val])
          return chain
        },
        maybeSingle: async () => ({ data: h.group, error: null }),
      }
      return chain
    },
  }
}

const req = (body: unknown) =>
  new Request('http://localhost/api/whatsapp/groups/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/whatsapp/groups/send', () => {
  beforeEach(() => {
    h.allowed = true
    h.group = { id: 'g-1', jid: '120363@g.us', monitored: true }
    h.sendText = vi.fn().mockResolvedValue({ messageId: 'true_120363@g.us_ABC' })
    h.provider = { sendText: h.sendText }
    h.upserts = []
    h.upsertRows = [{ id: 'm-1' }]
    h.upsertError = null
    h.groupUpdates = []
    h.groupLookups = []
    h.logged = []
    h.role.mockReset()
    h.role.mockResolvedValue({ supabase: callerClient(), accountId: 'acct-1', userId: 'u-1' })
  })

  it('requires the agent role', async () => {
    await POST(req({ group_id: 'g-1', text: 'Halo' }))
    expect(h.role).toHaveBeenCalledWith('agent')
  })

  it('sends to the group, then saves the message as the account\'s own', async () => {
    const res = await POST(req({ group_id: 'g-1', text: '  Halo semua  ' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, message_id: 'true_120363@g.us_ABC', saved: true })
    expect(h.sendText).toHaveBeenCalledWith({
      to: '120363@g.us',
      text: 'Halo semua',
      contextMessageId: undefined,
    })
    expect(h.upserts[0]).toMatchObject({
      table: 'whatsapp_group_messages',
      row: {
        group_id: 'g-1',
        account_id: 'acct-1',
        message_id: 'true_120363@g.us_ABC',
        from_me: true,
        content_type: 'text',
        content_text: 'Halo semua',
      },
      opts: { onConflict: 'group_id,message_id', ignoreDuplicates: true },
    })
    expect(h.groupUpdates[0]).toMatchObject({
      table: 'whatsapp_groups',
      patch: { last_message_text: 'Halo semua' },
    })
  })

  it('quotes the message it replies to', async () => {
    await POST(req({ group_id: 'g-1', text: 'Siap', reply_to_message_id: ' false_120363@g.us_XYZ_628@c.us ' }))
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ contextMessageId: 'false_120363@g.us_XYZ_628@c.us' }),
    )
  })

  it('looks the group up inside the caller\'s account', async () => {
    await POST(req({ group_id: 'g-1', text: 'Halo' }))
    expect(h.groupLookups).toContainEqual(['account_id', 'acct-1'])
  })

  it('rejects empty, blank and oversized text without sending', async () => {
    expect((await POST(req({ group_id: 'g-1', text: '   ' }))).status).toBe(400)
    expect((await POST(req({ group_id: 'g-1' }))).status).toBe(400)
    expect((await POST(req({ group_id: 'g-1', text: 'x'.repeat(MAX_GROUP_TEXT + 1) }))).status).toBe(400)
    expect((await POST(req({ group_id: 'g-1', text: 'x'.repeat(MAX_GROUP_TEXT) }))).status).toBe(200)
    expect(h.sendText).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing group id and unreadable bodies', async () => {
    expect((await POST(req({ text: 'Halo' }))).status).toBe(400)
    expect((await POST(req(null))).status).toBe(400)
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('returns 404 for a group outside the account or one that is not a group chat', async () => {
    h.group = null
    expect((await POST(req({ group_id: 'g-9', text: 'Halo' }))).status).toBe(404)
    h.group = { id: 'g-2', jid: '628123@c.us', monitored: true }
    expect((await POST(req({ group_id: 'g-2', text: 'Halo' }))).status).toBe(404)
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('refuses a group that is not monitored', async () => {
    h.group = { id: 'g-1', jid: '120363@g.us', monitored: false }
    expect((await POST(req({ group_id: 'g-1', text: 'Halo' }))).status).toBe(400)
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('refuses accounts that are not on WAHA', async () => {
    h.provider = null
    expect((await POST(req({ group_id: 'g-1', text: 'Halo' }))).status).toBe(400)
    expect(h.upserts).toEqual([])
  })

  it('stops at the rate limit before touching anything', async () => {
    h.allowed = false
    expect((await POST(req({ group_id: 'g-1', text: 'Halo' }))).status).toBe(429)
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('reports a failed send and saves nothing', async () => {
    h.sendText.mockRejectedValue(new Error('WAHA down'))
    const res = await POST(req({ group_id: 'g-1', text: 'Halo' }))
    expect(res.status).toBe(502)
    expect(h.upserts).toEqual([])
    expect(h.logged).toHaveLength(1)
  })

  it('does not fake a failure when only the save fails: the message is already out', async () => {
    h.upsertError = { message: 'db down' }
    h.upsertRows = null
    const res = await POST(req({ group_id: 'g-1', text: 'Halo' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, saved: false })
    expect(h.groupUpdates).toEqual([])
    expect(h.logged).toHaveLength(1)
  })

  it('leaves saving to the echo when WAHA gave no usable message id', async () => {
    h.sendText.mockResolvedValue({ messageId: 'waha-local-1234' })
    const res = await POST(req({ group_id: 'g-1', text: 'Halo' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, saved: false })
    expect(h.upserts).toEqual([])
  })

  it('does not bump the group row when the echo already saved the message', async () => {
    h.upsertRows = []
    const res = await POST(req({ group_id: 'g-1', text: 'Halo' }))
    expect(await res.json()).toMatchObject({ ok: true, saved: false })
    expect(h.groupUpdates).toEqual([])
  })
})
