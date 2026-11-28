import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

import { retrieveKnowledge, ingestDocument, fuseRankings } from './knowledge'

interface FakeState {
  semantic: { id: string; content: string }[]
  fts: { id: string; content: string }[]
  chunkCount: number
  rpcCalls: string[]
  inserted: Record<string, unknown>[] | null
  deletedIds: string[] | null
  existingChunkIds: string[]
  events: string[]
  insertError: unknown
}

function makeDb() {
  const state: FakeState = {
    semantic: [],
    fts: [],
    chunkCount: 5, // account has a non-empty KB by default
    rpcCalls: [],
    inserted: null,
    deletedIds: null,
    existingChunkIds: ['old-1', 'old-2'],
    events: [],
    insertError: null,
  }
  const db = {
    rpc: (name: string) => {
      state.rpcCalls.push(name)
      if (name === 'match_ai_knowledge_semantic')
        return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'match_ai_knowledge_fts')
        return Promise.resolve({ data: state.fts, error: null })
      return Promise.resolve({ data: null, error: null })
    },
    from: () => ({
      // retrieveKnowledge's empty-KB count guard.
      select: () => ({
        eq: () => {
          state.events.push('list')
          return Promise.resolve({
            count: state.chunkCount,
            data: state.existingChunkIds.map((id) => ({ id })),
            error: null,
          })
        },
      }),
      delete: () => ({
        in: (_col: string, ids: string[]) => {
          state.events.push('delete')
          state.deletedIds = [...(state.deletedIds ?? []), ...ids]
          return Promise.resolve({ error: null })
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        state.events.push('insert')
        if (state.insertError) return Promise.resolve({ error: state.insertError })
        state.inserted = rows
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_settings: unknown, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

describe('retrieveKnowledge', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await retrieveKnowledge(db, 'acct', { embeddings: null }, '  ')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 0
    const out = await retrieveKnowledge(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'q')
    expect(out).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
  })

  it('uses lexical FTS only when there is no embeddings key', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddings: null }, 'q')
    expect(out).toEqual(['F1'])
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_fts'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses semantic search when an embeddings key is present', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
      { id: 's3', content: 'S3' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'S3'])
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    // Lexical search always joins the fusion next to the semantic ranking.
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_semantic', 'match_ai_knowledge_fts'])
  })

  it('fuses semantic and lexical rankings; a hit in both ranks first', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
    ]
    state.fts = [
      { id: 's2', content: 'S2-dup' }, // dedup by id
      { id: 'f1', content: 'F1' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'q', 3)
    expect(out).toEqual(['S2', 'S1', 'F1'])
  })

  it('lets an exact-word lexical hit through even when semantic fills every slot', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
    ]
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'q', 3)
    expect(out).toContain('F1')
  })

  it('also embeds the latest message on its own and fuses both rankings', async () => {
    const { db, state } = makeDb()
    const calls: string[][] = []
    h.embedTexts.mockImplementation(async (_s: unknown, inputs: string[]) => {
      calls.push(inputs)
      return inputs.map((_, i) => [i + 1])
    })
    // Each embedding gets its own ranking: rpc returns by call order.
    const rankings = [
      [{ id: 'broad', content: 'BROAD' }],
      [{ id: 'focus', content: 'FOCUS' }],
    ]
    let n = 0
    ;(db as unknown as { rpc: (name: string) => Promise<unknown> }).rpc = (name: string) => {
      state.rpcCalls.push(name)
      if (name === 'match_ai_knowledge_semantic') return Promise.resolve({ data: rankings[n++], error: null })
      return Promise.resolve({ data: [], error: null })
    }
    const out = await retrieveKnowledge(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'topik A\nberapa biayanya?', 4, {
      focusText: 'berapa biayanya?',
    })
    expect(calls).toEqual([['topik A\nberapa biayanya?', 'berapa biayanya?']])
    expect(out).toEqual(expect.arrayContaining(['BROAD', 'FOCUS']))
  })

  it('does not embed the focus twice when it equals the query', async () => {
    const { db } = makeDb()
    await retrieveKnowledge(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'q', 3, { focusText: ' q ' })
    expect(h.embedTexts.mock.calls[0][1]).toEqual(['q'])
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    const { db, state } = makeDb()
    const result = await ingestDocument(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'doc-1', 'hello world')
    expect(result).toEqual({ keywordOnly: false, embedError: null })
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(state.deletedIds).toEqual(['old-1', 'old-2'])
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBe('[0,0]') // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddings: null }, 'doc-1', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'doc-1', '   ')
    expect(state.deletedIds).toEqual(['old-1', 'old-2'])
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('reports keyword-only success when embedding fails', async () => {
    const { db, state } = makeDb()
    const embedError = new Error('rate limited')
    h.embedTexts.mockRejectedValueOnce(embedError)
    const result = await ingestDocument(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'doc-1', 'hello world')
    expect(result).toEqual({ keywordOnly: true, embedError })
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('keeps the existing chunks until the embed has finished', async () => {
    const { db, state } = makeDb()
    h.embedTexts.mockImplementationOnce(async () => {
      expect(state.events).toEqual([])
      throw new Error('timeout')
    })
    await ingestDocument(db, 'acct', { embeddings: { apiKey: 'sk-x', baseUrl: null, model: null, dimensions: null } }, 'doc-1', 'hello world')
    expect(state.events).toEqual(['list', 'insert', 'delete'])
  })

  it('keeps the existing chunks when the insert fails', async () => {
    const { db, state } = makeDb()
    state.insertError = new Error('insert failed')
    await expect(
      ingestDocument(db, 'acct', { embeddings: null }, 'doc-1', 'hello world'),
    ).rejects.toThrow('insert failed')
    expect(state.deletedIds).toBeNull()
  })

  it('deletes previous chunks in batches', async () => {
    const { db, state } = makeDb()
    state.existingChunkIds = Array.from({ length: 250 }, (_, i) => `old-${i}`)
    await ingestDocument(db, 'acct', { embeddings: null }, 'doc-1', 'hello world')
    expect(state.events.filter((e) => e === 'delete')).toHaveLength(3)
    expect(state.deletedIds).toHaveLength(250)
  })
})

describe('fuseRankings', () => {
  it('ranks an item present in several lists above single-list items', () => {
    const out = fuseRankings([
      [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }],
      [{ id: 'c', content: 'C' }, { id: 'b', content: 'B' }],
    ])
    expect(out[0]).toBe('B')
    expect(out).toHaveLength(3)
  })

  it('keeps list order on ties and handles empty input', () => {
    expect(fuseRankings([])).toEqual([])
    expect(fuseRankings([[{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }]])).toEqual(['A', 'B'])
  })
})
