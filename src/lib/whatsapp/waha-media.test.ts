import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mediaIdForMessage, mirrorWahaMedia, rewriteWahaMediaUrl } from './waha-media'

describe('rewriteWahaMediaUrl', () => {
  it('re-roots a WAHA file path on WAHA_BASE_URL, whatever host WAHA reported', () => {
    expect(
      rewriteWahaMediaUrl('http://localhost:3000/api/files/s/abc.jpeg', 'http://waha:3000/'),
    ).toBe('http://waha:3000/api/files/s/abc.jpeg')
    expect(
      rewriteWahaMediaUrl('http://203.0.113.9:32768/api/files/s/abc.jpeg?x=1', 'http://waha:3000'),
    ).toBe('http://waha:3000/api/files/s/abc.jpeg?x=1')
  })

  it('refuses anything that is not a WAHA api path, or when no base is set', () => {
    expect(rewriteWahaMediaUrl('http://evil.test/steal', 'http://waha:3000')).toBeNull()
    expect(rewriteWahaMediaUrl('http://localhost:3000/api/files/a.jpg', undefined)).toBeNull()
    expect(rewriteWahaMediaUrl('not a url at all', 'http://waha:3000')).toBeNull()
  })
})

describe('mediaIdForMessage', () => {
  it('is stable, numeric and 19 digits', () => {
    const a = mediaIdForMessage('false_628@c.us_ABC')
    expect(a).toMatch(/^\d{19}$/)
    expect(mediaIdForMessage('false_628@c.us_ABC')).toBe(a)
    expect(mediaIdForMessage('false_628@c.us_ABD')).not.toBe(a)
  })
})

describe('mirrorWahaMedia', () => {
  const originalFetch = globalThis.fetch
  const uploaded: { path: string; type: string; bytes: number }[] = []
  const storage = {
    from: () => ({
      upload: async (path: string, body: Uint8Array | Buffer, opts: { contentType: string }) => {
        uploaded.push({ path, type: opts.contentType, bytes: body.byteLength })
        return { error: null }
      },
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
    }),
  }

  beforeEach(() => {
    uploaded.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  const base = { storage, accountId: 'acct-1', messageId: 'false_628@c.us_ABC', baseUrl: 'http://waha:3000', apiKey: 'k' }

  it('downloads with the API key and returns the stored public url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const url = await mirrorWahaMedia({
      ...base,
      media: { url: 'http://localhost:3000/api/files/s/abc.jpeg', mimetype: 'image/jpeg' },
      timestamp: 1_700_000_000,
    })

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe('http://waha:3000/api/files/s/abc.jpeg')
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('k')
    expect(url).toMatch(/^https:\/\/cdn\.test\/.+/)
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]).toMatchObject({ type: 'image/jpeg', bytes: 4 })
    expect(uploaded[0].path).toContain('account-acct-1')
  })

  it('returns null, without throwing, when WAHA sent no file', async () => {
    expect(await mirrorWahaMedia({ ...base, media: null })).toBeNull()
    expect(await mirrorWahaMedia({ ...base, media: { url: null } })).toBeNull()
    expect(uploaded).toHaveLength(0)
  })

  it('returns null when the download fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers() }) as unknown as typeof fetch
    expect(
      await mirrorWahaMedia({ ...base, media: { url: 'http://x/api/files/a.jpg', mimetype: 'image/jpeg' } }),
    ).toBeNull()
    expect(uploaded).toHaveLength(0)
  })

  it('does not fetch a url that is not a WAHA path', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(
      await mirrorWahaMedia({ ...base, media: { url: 'http://evil.test/anything', mimetype: 'image/jpeg' } }),
    ).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
