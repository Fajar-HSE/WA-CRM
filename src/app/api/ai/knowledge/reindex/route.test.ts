import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  docs: [] as { id: string; content: string }[],
  corrupt: false,
  waiting: [] as { document_id: string }[],
  ingest: vi.fn(),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'admin',
    supabase: {
      from: (table: string) =>
        table === 'ai_knowledge_chunks'
          ? {
              select: () => ({
                eq: () => ({
                  or: () => ({ limit: async () => ({ data: h.waiting, error: null }) }),
                }),
              }),
            }
          : {
              select: () => ({
                eq: async () => ({ data: h.docs, error: null }),
              }),
            },
    },
  }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 500,
  }),
}))

vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsSettings: async () => ({
    settings: { apiKey: 'sk-embed', baseUrl: null, model: null, dimensions: null },
    corrupt: h.corrupt,
  }),
}))

vi.mock('@/lib/ai/knowledge', () => ({ ingestDocument: h.ingest }))

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function reindex(body?: Record<string, unknown>) {
  const request = body
    ? new Request('http://t/api/ai/knowledge/reindex', { method: 'POST', body: JSON.stringify(body) })
    : undefined
  return POST(request) as unknown as Promise<{ status: number; body: Record<string, unknown> }>
}

beforeEach(() => {
  vi.stubEnv('AI_REINDEX_PAUSE_MS', '0')
  h.waiting = []
  __resetRateLimitForTests()
  h.corrupt = false
  h.docs = [
    { id: 'doc-1', content: 'one' },
    { id: 'doc-2', content: 'two' },
    { id: 'doc-3', content: 'three' },
  ]
  h.ingest.mockReset()
  h.ingest.mockResolvedValue({ keywordOnly: false, embedError: null })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => vi.unstubAllEnvs())

describe('POST /api/ai/knowledge/reindex', () => {
  it('reindexes every document', async () => {
    const res = await reindex()
    expect(res.body).toEqual({
      success: true,
      reindexed: 3,
      total: 3,
      failed: [],
      keyword_only: [],
      embed_error: null,
      skipped: 0,
      timed_out: false,
      started_at: expect.any(String),
    })
  })

  it('keeps going past a failing document and reports it', async () => {
    h.ingest.mockImplementation(async (_db, _acct, _cfg, id: string) => {
      if (id === 'doc-1') throw new Error('insert failed')
      return { keywordOnly: false, embedError: null }
    })
    const res = await reindex()
    expect(h.ingest).toHaveBeenCalledTimes(3)
    expect(res.body).toMatchObject({
      success: false,
      reindexed: 2,
      total: 3,
      failed: ['doc-1'],
    })
  })

  it('reports keyword-only documents separately from failures', async () => {
    h.ingest.mockImplementation(async (_db, _acct, _cfg, id: string) =>
      id === 'doc-2'
        ? { keywordOnly: true, embedError: new Error('rate limited') }
        : { keywordOnly: false, embedError: null },
    )
    const res = await reindex()
    expect(res.body).toMatchObject({
      success: true,
      reindexed: 3,
      failed: [],
      keyword_only: ['doc-2'],
    })
  })

  it('stops calling the provider after 3 failures in a row and says why', async () => {
    h.docs = Array.from({ length: 6 }, (_, i) => ({ id: `doc-${i + 1}`, content: 'x' }))
    h.ingest.mockResolvedValue({
      keywordOnly: true,
      embedError: new Error('Invalid API key sk-live-abcdefghijklmnop'),
    })
    const res = await reindex()
    expect(h.ingest).toHaveBeenCalledTimes(3)
    expect(res.body).toMatchObject({ success: true, reindexed: 3, total: 6, skipped: 3 })
    expect(res.body.embed_error).toContain('Invalid API key')
    expect(String(res.body.embed_error)).not.toContain('abcdefghijklmnop')
  })

  it('a good document in between resets the failure streak', async () => {
    h.docs = Array.from({ length: 6 }, (_, i) => ({ id: `doc-${i + 1}`, content: 'x' }))
    h.ingest.mockImplementation(async (_db, _acct, _cfg, id: string) =>
      ['doc-1', 'doc-2', 'doc-4', 'doc-5'].includes(id)
        ? { keywordOnly: true, embedError: new Error('slow') }
        : { keywordOnly: false, embedError: null },
    )
    const res = await reindex()
    expect(h.ingest).toHaveBeenCalledTimes(6)
    expect(res.body).toMatchObject({ skipped: 0 })
  })

  it('continues an unfinished run: only documents still waiting', async () => {
    h.waiting = [{ document_id: 'doc-2' }, { document_id: 'doc-3' }]
    const since = '2026-01-01T00:00:00.000Z'
    const res = await reindex({ since })
    expect(h.ingest).toHaveBeenCalledTimes(2)
    expect(h.ingest.mock.calls.map((c) => c[3])).toEqual(['doc-2', 'doc-3'])
    expect(res.body).toMatchObject({ reindexed: 2, total: 2, started_at: since })
  })

  it('ignores a bad "since" value and does a full run', async () => {
    await reindex({ since: 'not a date' })
    expect(h.ingest).toHaveBeenCalledTimes(3)
  })

  it('stops before indexing when the embeddings key is corrupt', async () => {
    h.corrupt = true
    const res = await reindex()
    expect(h.ingest).not.toHaveBeenCalled()
    expect(res.body).toMatchObject({ success: false, reindexed: 0 })
  })
})
