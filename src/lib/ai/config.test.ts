import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig, loadEmbeddingsSettings, fetchAiConfigRow } from './config'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  base_url: null,
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.baseUrl).toBeNull()
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

/** A db whose first select fails with `firstError`, then returns `row`. */
function dbFailingFirst(
  firstError: { code?: string; message: string },
  row: Record<string, unknown> | null,
) {
  const selects: string[] = []
  let n = 0
  const chain = {
    from: () => chain,
    select: (cols: string) => {
      selects.push(cols)
      return chain
    },
    eq: () => chain,
    maybeSingle: () =>
      Promise.resolve(
        n++ === 0 ? { data: null, error: firstError } : { data: row, error: null },
      ),
  }
  return { db: chain as unknown as SupabaseClient, selects }
}

describe('embeddings settings', () => {
  const ACTIVE = { ...ROW, is_active: true, embeddings_api_key: 'enc-emb' }

  it('builds OpenAI defaults when only a key is stored', async () => {
    const config = await loadAiConfig(
      dbReturning({
        ...ACTIVE,
        embeddings_base_url: null,
        embeddings_model: null,
        embeddings_dimensions: null,
      }),
      'acct',
    )
    expect(config!.embeddings).toEqual({
      apiKey: 'plain:enc-emb',
      baseUrl: null,
      model: null,
      dimensions: null,
    })
  })

  it('carries a custom base URL, model and dimensions', async () => {
    const config = await loadAiConfig(
      dbReturning({
        ...ACTIVE,
        embeddings_base_url: 'https://emb.example.com/v1',
        embeddings_model: 'my-model',
        embeddings_dimensions: 768,
      }),
      'acct',
    )
    expect(config!.embeddings).toEqual({
      apiKey: 'plain:enc-emb',
      baseUrl: 'https://emb.example.com/v1',
      model: 'my-model',
      dimensions: 768,
    })
  })

  it('has no embeddings settings without a key', async () => {
    const config = await loadAiConfig(dbReturning({ ...ACTIVE, embeddings_api_key: null }), 'acct')
    expect(config!.embeddings).toBeNull()
  })

  it('loadEmbeddingsSettings returns the same settings, independent of is_active', async () => {
    const out = await loadEmbeddingsSettings(
      dbReturning({
        embeddings_api_key: 'enc-emb',
        embeddings_base_url: 'https://emb.example.com/v1',
        embeddings_model: 'my-model',
        embeddings_dimensions: null,
      }),
      'acct',
    )
    expect(out.corrupt).toBe(false)
    expect(out.settings).toMatchObject({ apiKey: 'plain:enc-emb', model: 'my-model' })
  })
})

describe('fetchAiConfigRow before migration 067', () => {
  it('retries without the new columns on a missing-column error and fills nulls', async () => {
    const { db, selects } = dbFailingFirst(
      { code: '42703', message: 'column ai_configs.embeddings_base_url does not exist' },
      { provider: 'openai' },
    )
    const out = await fetchAiConfigRow(db, 'acct', 'provider')
    expect(out.error).toBeNull()
    expect(out.data).toEqual({
      provider: 'openai',
      embeddings_base_url: null,
      embeddings_model: null,
      embeddings_dimensions: null,
    })
    expect(selects[0]).toContain('embeddings_base_url')
    expect(selects[1]).toBe('provider')
  })

  it('also recognises the PostgREST schema-cache error', async () => {
    const { db } = dbFailingFirst(
      { code: 'PGRST204', message: "Could not find the 'embeddings_model' column" },
      { provider: 'openai' },
    )
    const out = await fetchAiConfigRow(db, 'acct', 'provider')
    expect(out.error).toBeNull()
    expect(out.data).toMatchObject({ embeddings_model: null })
  })

  it('does not retry on an unrelated error', async () => {
    const { db, selects } = dbFailingFirst({ code: '57014', message: 'timeout' }, null)
    const out = await fetchAiConfigRow(db, 'acct', 'provider')
    expect(out.error).toMatchObject({ message: 'timeout' })
    expect(selects).toHaveLength(1)
  })
})
