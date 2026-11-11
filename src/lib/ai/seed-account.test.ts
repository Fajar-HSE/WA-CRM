import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { seedAiDefaults, templateAccountId, AI_SEED_DOC_BATCH } from './seed-account'

// ============================================================
// Fake Supabase: a tiny query-builder fake covering exactly the
// chains seedAiDefaults uses (select/insert/order/range/maybeSingle,
// plus the { count, head } guard).
// ============================================================

interface TemplateDoc {
  id: string
  title: string
  content: string
  created_at: string
}

interface TemplateChunk {
  document_id: string
  chunk_index: number
  content: string
  embedding: number[] | null
}

interface FakeState {
  targetHasConfig: boolean
  targetDocCount: number
  templateConfig: Record<string, unknown> | null
  templateDocs: TemplateDoc[]
  templateChunks: TemplateChunk[]
  configInserts: Record<string, unknown>[]
  docInserts: Record<string, unknown>[]
  chunkInserts: Record<string, unknown>[]
  insertErrors: { table?: string; error?: { message: string } }
  nextDocId: number
}

function makeDb(state: FakeState) {
  function builder(table: string) {
    const op = {
      table,
      kind: 'select' as 'select' | 'insert',
      cols: '',
      head: false,
      rows: [] as Record<string, unknown>[],
      eqCol: '' as string,
      eqVal: null as unknown,
      range: null as [number, number] | null,
    }

    const run = () => {
      if (op.kind === 'insert') {
        if (state.insertErrors.table === table) {
          return { data: null, error: state.insertErrors.error }
        }
        if (table === 'ai_configs') {
          state.configInserts.push(...op.rows)
          return { data: null, error: null }
        }
        if (table === 'ai_knowledge_documents') {
          state.docInserts.push(...op.rows)
          const data = op.rows.map((r) => ({
            id: `new-${state.nextDocId++}`,
            title: r.title,
            content: r.content,
          }))
          return { data, error: null }
        }
        if (table === 'ai_knowledge_chunks') {
          state.chunkInserts.push(...op.rows)
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }

      // select
      if (table === 'ai_configs' && op.cols === 'id') {
        return {
          data: state.targetHasConfig ? { id: 'existing' } : null,
          error: null,
          count: null,
        }
      }
      if (table === 'ai_knowledge_documents' && op.head) {
        return { data: null, error: null, count: state.targetDocCount }
      }
      if (table === 'ai_configs' && op.eqVal !== null) {
        return { data: state.templateConfig, error: null, count: null }
      }
      if (table === 'ai_knowledge_documents') {
        const all = state.templateDocs
        const [from, to] = op.range ?? [0, all.length - 1]
        return { data: all.slice(from, to + 1), error: null, count: null }
      }
      if (table === 'ai_knowledge_chunks') {
        const all = state.templateChunks
        const [from, to] = op.range ?? [0, all.length - 1]
        return { data: all.slice(from, to + 1), error: null, count: null }
      }
      return { data: null, error: null, count: null }
    }

    const chain = {
      select(cols: string, opts?: { count?: string; head?: boolean }) {
        op.cols = cols
        if (opts?.head) op.head = true
        return chain
      },
      insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
        op.kind = 'insert'
        op.rows = Array.isArray(rows) ? rows : [rows]
        return chain
      },
      eq(col: string, val: unknown) {
        op.eqCol = col
        op.eqVal = val
        return chain
      },
      order() {
        return chain
      },
      range(from: number, to: number) {
        op.range = [from, to]
        return chain
      },
      maybeSingle() {
        return Promise.resolve(run())
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve)
      },
    }
    return chain
  }

  return { from: (table: string) => builder(table) } as unknown as SupabaseClient
}

const TARGET = 'target-account'
const CREATOR = 'user-42'

function baseState(): FakeState {
  return {
    targetHasConfig: false,
    targetDocCount: 0,
    templateConfig: {
      provider: 'openai_compatible',
      model: 'deepseek-v4.1-flash',
      api_key: 'enc:key',
      system_prompt: 'Instruksi lengkap',
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 5,
      embeddings_api_key: null,
      base_url: 'https://api.example',
      handoff_agent_id: 'template-user-1',
    },
    templateDocs: [
      { id: 'd1', title: 'Profil', content: 'isi profil', created_at: '2026-01-01' },
      { id: 'd2', title: 'FAQ', content: 'isi faq', created_at: '2026-01-02' },
    ],
    templateChunks: [
      { document_id: 'd1', chunk_index: 0, content: 'isi profil', embedding: null },
      { document_id: 'd2', chunk_index: 0, content: 'isi faq', embedding: null },
    ],
    configInserts: [],
    docInserts: [],
    chunkInserts: [],
    insertErrors: {},
    nextDocId: 1,
  }
}

beforeEach(() => {
  delete process.env.AI_SEED_TEMPLATE_ACCOUNT_ID
})

afterEach(() => {
  delete process.env.AI_SEED_TEMPLATE_ACCOUNT_ID
})

describe('templateAccountId', () => {
  it('falls back to the built-in default', () => {
    expect(templateAccountId()).toBe('893a144a-2f11-406f-80ab-13798510b057')
  })

  it('honours the env override', () => {
    process.env.AI_SEED_TEMPLATE_ACCOUNT_ID = 'custom-account'
    expect(templateAccountId()).toBe('custom-account')
  })
})

describe('seedAiDefaults', () => {
  it('copies config, documents and chunks into an empty account', async () => {
    const state = baseState()
    const db = makeDb(state)

    const result = await seedAiDefaults(db, TARGET, CREATOR)

    expect(result.seeded).toBe(true)
    expect(result.documents).toBe(2)
    expect(result.chunks).toBe(2)

    // Config copied with account-specific fields replaced.
    expect(state.configInserts).toHaveLength(1)
    const cfg = state.configInserts[0]
    expect(cfg.account_id).toBe(TARGET)
    expect(cfg.created_by).toBe(CREATOR)
    expect(cfg.provider).toBe('openai_compatible')
    expect(cfg.api_key).toBe('enc:key')
    expect(cfg.system_prompt).toBe('Instruksi lengkap')
    expect(cfg.handoff_agent_id).toBeNull()

    // Documents copied and stamped.
    expect(state.docInserts).toHaveLength(2)
    expect(state.docInserts.every((d) => d.account_id === TARGET)).toBe(true)
    expect(state.docInserts.every((d) => d.created_by === CREATOR)).toBe(true)

    // Chunks remapped onto the NEW document ids (new-1 / new-2).
    expect(state.chunkInserts).toHaveLength(2)
    expect(state.chunkInserts.map((c) => c.document_id).sort()).toEqual(['new-1', 'new-2'])
    expect(state.chunkInserts.every((c) => c.account_id === TARGET)).toBe(true)
  })

  it('skips entirely when the target already has config and KB', async () => {
    const state = baseState()
    state.targetHasConfig = true
    state.targetDocCount = 5
    const db = makeDb(state)

    const result = await seedAiDefaults(db, TARGET, CREATOR)

    expect(result).toEqual({
      seeded: false,
      reason: 'already-configured',
      documents: 0,
      chunks: 0,
    })
    expect(state.configInserts).toHaveLength(0)
    expect(state.docInserts).toHaveLength(0)
    expect(state.chunkInserts).toHaveLength(0)
  })

  it('resumes: copies only the KB when the config already exists', async () => {
    const state = baseState()
    state.targetHasConfig = true
    const db = makeDb(state)

    const result = await seedAiDefaults(db, TARGET, CREATOR)

    expect(result.seeded).toBe(true)
    expect(result.documents).toBe(2)
    expect(state.configInserts).toHaveLength(0)
    expect(state.docInserts).toHaveLength(2)
  })

  it('does not duplicate docs when the insert exceeds one batch', async () => {
    const state = baseState()
    state.templateDocs = Array.from({ length: AI_SEED_DOC_BATCH + 5 }, (_, i) => ({
      id: `d${i}`,
      title: `Doc ${i}`,
      content: `content ${i}`,
      created_at: `2026-01-${String(i).padStart(2, '0')}`,
    }))
    state.templateChunks = state.templateDocs.map((d) => ({
      document_id: d.id,
      chunk_index: 0,
      content: d.content,
      embedding: null,
    }))
    const db = makeDb(state)

    const result = await seedAiDefaults(db, TARGET, CREATOR)

    expect(result.seeded).toBe(true)
    expect(result.documents).toBe(AI_SEED_DOC_BATCH + 5)
    expect(state.docInserts).toHaveLength(AI_SEED_DOC_BATCH + 5)
    expect(result.chunks).toBe(AI_SEED_DOC_BATCH + 5)
    // Every chunk lands on a distinct new doc id — no collapse.
    const docIds = new Set(state.chunkInserts.map((c) => c.document_id))
    expect(docIds.size).toBe(AI_SEED_DOC_BATCH + 5)
  })

  it('throws on a config insert failure so the caller can log it', async () => {
    const state = baseState()
    state.insertErrors = { table: 'ai_configs', error: { message: 'boom' } }
    const db = makeDb(state)

    await expect(seedAiDefaults(db, TARGET, CREATOR)).rejects.toThrow('boom')
  })

  it('reports no-template when the template account is missing', async () => {
    const state = baseState()
    state.templateConfig = null
    state.templateDocs = []
    state.templateChunks = []
    const db = makeDb(state)

    const result = await seedAiDefaults(db, TARGET, CREATOR)

    expect(result.seeded).toBe(false)
    expect(result.reason).toBe('no-template')
    expect(state.configInserts).toHaveLength(0)
  })

  it('refuses to seed an account into itself', async () => {
    const state = baseState()
    state.targetHasConfig = false
    const db = makeDb(state)
    const selfId = templateAccountId()

    const result = await seedAiDefaults(db, selfId, CREATOR)

    expect(result.seeded).toBe(false)
    expect(result.reason).toBe('no-template')
    expect(state.configInserts).toHaveLength(0)
  })
})
