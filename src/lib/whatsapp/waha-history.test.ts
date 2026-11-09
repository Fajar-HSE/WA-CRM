import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { HistoryImportError, historyRow, importChatHistory } from './waha-history'

const CONV = '11111111-1111-4111-8111-111111111111'

describe('historyRow', () => {
  it('maps a customer message', () => {
    expect(
      historyRow({ id: 'false_1@c.us_A', timestamp: 1_700_000_000, fromMe: false, body: ' halo ' }, CONV),
    ).toEqual({
      conversation_id: CONV,
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'halo',
      media_url: null,
      message_id: 'false_1@c.us_A',
      status: 'delivered',
      created_at: new Date(1_700_000_000 * 1000).toISOString(),
    })
  })

  it('maps a message sent from our side as an agent message', () => {
    expect(
      historyRow({ id: 'true_1@c.us_B', timestamp: 1_700_000_100, fromMe: true, body: 'siap' }, CONV),
    ).toMatchObject({ sender_type: 'agent', status: 'sent' })
  })

  it('keeps a marker for a media message without text', () => {
    const row = historyRow({ id: 'x', timestamp: 5, hasMedia: true, body: '' }, CONV)
    expect(row?.content_text).toMatch(/^\[(Lampiran|Attachment)\]$/)
    expect(row?.media_url).toBeNull()
  })

  it('drops rows that have no id, no time, or nothing to show', () => {
    expect(historyRow({ timestamp: 5, body: 'a' }, CONV)).toBeNull()
    expect(historyRow({ id: 'x', body: 'a' }, CONV)).toBeNull()
    expect(historyRow({ id: 'x', timestamp: 5, body: '   ' }, CONV)).toBeNull()
  })
})

interface FakeOpts {
  conv?: unknown
  existing?: string[]
}

function makeDb(opts: FakeOpts = {}) {
  const upserts: Record<string, unknown>[][] = []
  const conv =
    'conv' in opts
      ? opts.conv
      : { id: CONV, contact: { phone: '628123456789' } }
  const db = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: async () => ({
          data: (opts.existing ?? []).map((message_id) => ({ message_id })),
          error: null,
        }),
        maybeSingle: async () => ({ data: table === 'conversations' ? conv : null, error: null }),
        upsert: async (rows: Record<string, unknown>[]) => {
          upserts.push(rows)
          return { error: null }
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { db, upserts }
}

const page = [
  { id: 'false_1@c.us_C', timestamp: 300, fromMe: false, body: 'tiga' },
  { id: 'true_1@c.us_B', timestamp: 200, fromMe: true, body: 'dua' },
  { id: 'false_1@c.us_A', timestamp: 100, fromMe: false, body: 'satu' },
]

describe('importChatHistory', () => {
  it('writes only messages the conversation does not have yet', async () => {
    const { db, upserts } = makeDb({ existing: ['false_1@c.us_A'] })
    const provider = { listChatMessages: vi.fn(async () => page) }

    const res = await importChatHistory({
      db,
      accountId: 'acct-1',
      conversationId: CONV,
      provider,
      limit: 100,
    })

    expect(provider.listChatMessages).toHaveBeenCalledWith('628123456789', { limit: 100, offset: 0 })
    expect(res).toEqual({ fetched: 3, imported: 2, skipped: 1, hasMore: false })
    expect(upserts).toHaveLength(1)
    expect(upserts[0].map((r) => r.message_id)).toEqual(['false_1@c.us_C', 'true_1@c.us_B'])
  })

  it('reports that more may exist when WAHA returns a full page', async () => {
    const { db } = makeDb()
    const provider = { listChatMessages: async () => page }
    const res = await importChatHistory({
      db,
      accountId: 'acct-1',
      conversationId: CONV,
      provider,
      limit: 3,
    })
    expect(res.hasMore).toBe(true)
  })

  it('passes the offset on and writes nothing for an empty page', async () => {
    const { db, upserts } = makeDb()
    const provider = { listChatMessages: vi.fn(async () => []) }
    const res = await importChatHistory({
      db,
      accountId: 'acct-1',
      conversationId: CONV,
      provider,
      limit: 100,
      offset: 200,
    })
    expect(provider.listChatMessages).toHaveBeenCalledWith('628123456789', { limit: 100, offset: 200 })
    expect(res).toEqual({ fetched: 0, imported: 0, skipped: 0, hasMore: false })
    expect(upserts).toEqual([])
  })

  it('writes nothing when everything is already there', async () => {
    const { db, upserts } = makeDb({ existing: page.map((p) => p.id) })
    const res = await importChatHistory({
      db,
      accountId: 'acct-1',
      conversationId: CONV,
      provider: { listChatMessages: async () => page },
    })
    expect(res.imported).toBe(0)
    expect(upserts).toEqual([])
  })

  it('fails with 404 for an unknown conversation', async () => {
    const { db } = makeDb({ conv: null })
    await expect(
      importChatHistory({
        db,
        accountId: 'acct-1',
        conversationId: CONV,
        provider: { listChatMessages: async () => [] },
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('fails with 400 when the contact has no phone', async () => {
    const { db } = makeDb({ conv: { id: CONV, contact: { phone: '  ' } } })
    const err = await importChatHistory({
      db,
      accountId: 'acct-1',
      conversationId: CONV,
      provider: { listChatMessages: async () => [] },
    }).catch((e) => e)
    expect(err).toBeInstanceOf(HistoryImportError)
    expect(err.status).toBe(400)
  })

  it('accepts the contact embedded as a one-element array', async () => {
    const { db } = makeDb({ conv: { id: CONV, contact: [{ phone: '628111' }] } })
    const provider = { listChatMessages: vi.fn(async () => []) }
    await importChatHistory({ db, accountId: 'a', conversationId: CONV, provider })
    expect(provider.listChatMessages).toHaveBeenCalledWith('628111', { limit: 100, offset: 0 })
  })
})
