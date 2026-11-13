import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EmbeddingsSettings } from './embeddings'
import { embedTexts, embeddingsEndpoint, toVectorLiteral } from './embeddings'
import { AiError } from './types'

const h = vi.hoisted(() => ({ deliverable: vi.fn() }))
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: h.deliverable }))

const openai = (apiKey = 'sk-x'): EmbeddingsSettings => ({
  apiKey,
  baseUrl: null,
  model: null,
  dimensions: null,
})
const custom = (over: Partial<EmbeddingsSettings> = {}): EmbeddingsSettings => ({
  apiKey: 'k-custom',
  baseUrl: 'https://emb.example.com/v1',
  model: 'my-model',
  dimensions: null,
  ...over,
})

function okEmbeddings(count: number, shuffle = false): Response {
  const rows = Array.from({ length: count }, (_, i) => ({
    embedding: [i, i + 0.5],
    index: i,
  }))
  if (shuffle) rows.reverse()
  return { ok: true, status: 200, json: async () => ({ data: rows }) } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  h.deliverable.mockReset()
  h.deliverable.mockResolvedValue(true)
})
afterEach(() => vi.unstubAllGlobals())

describe('toVectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]')
  })
})

describe('embedTexts', () => {
  it('returns [] and makes no request for empty input', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await embedTexts(openai(), [])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('embeds a single batch and sends the key', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length
      return okEmbeddings(n)
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await embedTexts(openai(), ['a', 'b', 'c'])
    expect(out).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(
      (opts as unknown as { headers: Record<string, string> }).headers.Authorization,
    ).toBe('Bearer sk-x')
  })

  it('splits large inputs into multiple batches', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length
      return okEmbeddings(n)
    })
    vi.stubGlobal('fetch', fetchMock)

    const inputs = Array.from({ length: 100 }, (_, i) => `t${i}`)
    const out = await embedTexts(openai(), inputs)
    expect(out).toHaveLength(100)
    expect(fetchMock).toHaveBeenCalledTimes(2) // 96 + 4
  })

  it('reorders by index when the provider returns them shuffled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: { body: string }) => {
        const n = JSON.parse(opts.body).input.length
        return okEmbeddings(n, true)
      }),
    )
    const out = await embedTexts(openai(), ['a', 'b', 'c'])
    expect(out[0]).toEqual([0, 0.5]) // index 0 first despite shuffle
    expect(out[2]).toEqual([2, 2.5])
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'bad key' } }),
      } as unknown as Response),
    )
    await expect(embedTexts(openai(), ['a'])).rejects.toMatchObject({
      code: 'invalid_key',
    })
  })

  it('throws when the provider omits result indices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.1] }, { embedding: [0.2] }] }),
      } as unknown as Response),
    )
    await expect(embedTexts(openai(), ['a', 'b'])).rejects.toBeInstanceOf(AiError)
  })

  it('throws on a malformed response (count mismatch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as unknown as Response),
    )
    await expect(embedTexts(openai(), ['a', 'b'])).rejects.toBeInstanceOf(AiError)
  })
})

describe('embeddingsEndpoint', () => {
  it('defaults to OpenAI when the base URL is blank', () => {
    expect(embeddingsEndpoint(null)).toBe('https://api.openai.com/v1/embeddings')
    expect(embeddingsEndpoint('  ')).toBe('https://api.openai.com/v1/embeddings')
  })

  it('appends /embeddings to a custom base URL', () => {
    expect(embeddingsEndpoint('https://emb.example.com/v1/')).toBe(
      'https://emb.example.com/v1/embeddings',
    )
  })

  it('accepts a base URL that already ends in /embeddings', () => {
    expect(embeddingsEndpoint('https://emb.example.com/v1/embeddings')).toBe(
      'https://emb.example.com/v1/embeddings',
    )
  })

  it('rejects plain http and URLs with credentials', () => {
    expect(() => embeddingsEndpoint('http://emb.example.com/v1')).toThrow()
    expect(() => embeddingsEndpoint('https://u:p@emb.example.com/v1')).toThrow()
  })
})

describe('embedTexts with a custom provider', () => {
  function stubOk() {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) =>
      okEmbeddings(JSON.parse(opts.body).input.length),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('posts to the custom endpoint with its model and key, never following redirects', async () => {
    const fetchMock = stubOk()
    await embedTexts(custom(), ['a'])
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; redirect: string; headers: Record<string, string> },
    ]
    expect(url).toBe('https://emb.example.com/v1/embeddings')
    expect(opts.redirect).toBe('manual')
    expect(opts.headers.Authorization).toBe('Bearer k-custom')
    const body = JSON.parse(opts.body)
    expect(body.model).toBe('my-model')
    expect(body).not.toHaveProperty('dimensions')
  })

  it('uses the default OpenAI model when none is set', async () => {
    const fetchMock = stubOk()
    await embedTexts(openai(), ['a'])
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.model).toBe('text-embedding-3-small')
  })

  it('requires a model for a custom base URL', async () => {
    const fetchMock = stubOk()
    await expect(embedTexts(custom({ model: null }), ['a'])).rejects.toMatchObject({
      code: 'embeddings_model_required',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks an endpoint the SSRF guard rejects, without sending the key', async () => {
    const fetchMock = stubOk()
    h.deliverable.mockResolvedValue(false)
    await expect(embedTexts(custom(), ['a'])).rejects.toMatchObject({ code: 'blocked_url' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends dimensions when set and accepts a matching vector size', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [1, 2, 3] })),
        }),
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await embedTexts(custom({ dimensions: 3 }), ['a', 'b'])
    expect(out).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ])
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.dimensions).toBe(3)
  })

  it('fails when the provider ignores the requested dimensions', async () => {
    stubOk() // returns 2-number vectors
    await expect(embedTexts(custom({ dimensions: 768 }), ['a'])).rejects.toMatchObject({
      code: 'embeddings_dimension_mismatch',
    })
  })

  it('fails when vectors in one response differ in size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { index: 0, embedding: [1, 2] },
            { index: 1, embedding: [1, 2, 3] },
          ],
        }),
      } as unknown as Response),
    )
    await expect(embedTexts(openai(), ['a', 'b'])).rejects.toBeInstanceOf(AiError)
  })
})

describe('embedTexts retries a busy provider', () => {
  const rateLimited = (retryAfter?: string) =>
    ({
      ok: false,
      status: 429,
      headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
      json: async () => ({ error: { message: 'Embeddings provider rate limit reached' } }),
    }) as unknown as Response

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits and tries again after a 429, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(okEmbeddings(1))
    vi.stubGlobal('fetch', fetchMock)
    const pending = embedTexts(openai(), ['a'])
    await vi.advanceTimersByTimeAsync(1000) // 1st wait
    await vi.advanceTimersByTimeAsync(2000) // 2nd wait
    await expect(pending).resolves.toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('honours Retry-After, capped at 10 seconds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited('60'))
      .mockResolvedValueOnce(okEmbeddings(1))
    vi.stubGlobal('fetch', fetchMock)
    const pending = embedTexts(openai(), ['a'])
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2)
    await expect(pending).resolves.toHaveLength(1)
  })

  it('gives up after 3 retries with a rate_limited error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited())
    vi.stubGlobal('fetch', fetchMock)
    const pending = embedTexts(openai(), ['a'])
    const assertion = expect(pending).rejects.toMatchObject({ code: 'rate_limited' })
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not retry an invalid key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({ error: { message: 'bad key' } }),
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(embedTexts(openai(), ['a'])).rejects.toMatchObject({ code: 'invalid_key' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
