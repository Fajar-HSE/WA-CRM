import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  stored: null as Record<string, unknown> | null,
  validateCalls: [] as { provider: string; apiKey: string; baseUrl: string | null }[],
  updates: [] as Record<string, unknown>[],
  embedCalls: [] as unknown[],
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
  getCurrentAccount: async () => {
    throw new Error('not used')
  },
  requireRole: async () => ({
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'admin',
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: h.stored, error: null }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async () => {
            h.updates.push(patch)
            return { error: null }
          },
        }),
      }),
    },
  }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 403,
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => `plain:${value}`,
  encrypt: (value: string) => `enc:${value}`,
}))

vi.mock('@/lib/ai/validate', () => ({
  validateAiCredentials: async (cfg: { provider: string; apiKey: string; baseUrl: string | null }) => {
    h.validateCalls.push({ provider: cfg.provider, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })
  },
}))

vi.mock('@/lib/ai/embeddings', () => ({
  embedTexts: async (settings: unknown) => {
    h.embedCalls.push(settings)
    return []
  },
}))

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://t/api/ai/config', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<{ status: number; body: Record<string, unknown> }>
}

beforeEach(() => {
  __resetRateLimitForTests()
  h.validateCalls = []
  h.updates = []
  h.embedCalls = []
  h.stored = {
    id: 'cfg-1',
    provider: 'openai_compatible',
    model: 'm',
    base_url: 'https://8.8.8.8/v1',
    api_key: 'enc-key',
  }
})

describe('POST /api/ai/config stored key reuse', () => {
  it('keeps the stored key when only non-credential fields change', async () => {
    const res = await post({
      provider: 'openai_compatible',
      model: 'm',
      base_url: 'https://8.8.8.8/v1',
      system_prompt: 'Be brief',
    })
    expect(res.status).toBe(200)
    expect(h.validateCalls).toHaveLength(0)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).not.toHaveProperty('api_key')
  })

  it('reuses the stored key when the model changes on the same endpoint', async () => {
    const res = await post({ provider: 'openai_compatible', model: 'm2', base_url: 'https://8.8.8.8/v1/' })
    expect(res.status).toBe(200)
    expect(h.validateCalls).toEqual([
      { provider: 'openai_compatible', apiKey: 'plain:enc-key', baseUrl: 'https://8.8.8.8/v1/' },
    ])
  })

  it('refuses to move the stored key to a new base URL', async () => {
    const res = await post({ provider: 'openai_compatible', model: 'm', base_url: 'https://1.1.1.1/v1' })
    expect(res.status).toBe(400)
    expect(h.validateCalls).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
  })

  it('refuses to move the stored key to a new provider', async () => {
    const res = await post({ provider: 'anthropic', model: 'claude' })
    expect(res.status).toBe(400)
    expect(h.validateCalls).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
  })

  it('saves a new base URL together with a freshly entered key', async () => {
    const res = await post({
      provider: 'openai_compatible',
      model: 'm',
      base_url: 'https://1.1.1.1/v1',
      api_key: 'new-key',
    })
    expect(res.status).toBe(200)
    expect(h.validateCalls).toEqual([
      { provider: 'openai_compatible', apiKey: 'new-key', baseUrl: 'https://1.1.1.1/v1' },
    ])
    expect(h.updates[0]).toMatchObject({ base_url: 'https://1.1.1.1/v1', api_key: 'enc:new-key' })
  })
})

describe('POST /api/ai/config embeddings provider', () => {
  const chat = { provider: 'openai_compatible', model: 'm', base_url: 'https://8.8.8.8/v1' }

  it('saves a custom embeddings endpoint, validating it with the stored key', async () => {
    h.stored = { ...(h.stored as object), embeddings_api_key: 'enc-emb' }
    const res = await post({
      ...chat,
      embeddings_base_url: 'https://1.1.1.1/v1',
      embeddings_model: 'my-model',
      embeddings_dimensions: 768,
    })
    expect(res.status).toBe(200)
    expect(res.body.embeddings_changed).toBe(true)
    expect(h.embedCalls).toEqual([
      { apiKey: 'plain:enc-emb', baseUrl: 'https://1.1.1.1/v1', model: 'my-model', dimensions: 768 },
    ])
    expect(h.updates[0]).toMatchObject({
      embeddings_base_url: 'https://1.1.1.1/v1',
      embeddings_model: 'my-model',
      embeddings_dimensions: 768,
    })
  })

  it('requires a model when a base URL is given', async () => {
    const res = await post({ ...chat, embeddings_base_url: 'https://1.1.1.1/v1' })
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it.each([4, 9000, 1.5, 'abc'])('rejects dimensions %s', async (dims) => {
    const res = await post({ ...chat, embeddings_dimensions: dims })
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it('does not touch the embeddings setup when the fields are not sent', async () => {
    const res = await post({ ...chat, system_prompt: 'x' })
    expect(res.status).toBe(200)
    expect(res.body.embeddings_changed).toBe(false)
    expect(h.embedCalls).toHaveLength(0)
    expect(h.updates[0]).not.toHaveProperty('embeddings_base_url')
    expect(h.updates[0]).not.toHaveProperty('embeddings_model')
  })

  it('resets to OpenAI defaults when the fields are sent blank', async () => {
    h.stored = {
      ...(h.stored as object),
      embeddings_base_url: 'https://1.1.1.1/v1',
      embeddings_model: 'my-model',
      embeddings_dimensions: 768,
    }
    const res = await post({
      ...chat,
      embeddings_base_url: '',
      embeddings_model: '',
      embeddings_dimensions: null,
    })
    expect(res.status).toBe(200)
    expect(res.body.embeddings_changed).toBe(true)
    expect(h.updates[0]).toMatchObject({
      embeddings_base_url: null,
      embeddings_model: null,
      embeddings_dimensions: null,
    })
  })
})
