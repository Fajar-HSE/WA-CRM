import { describe, expect, it } from 'vitest'

import { providerHttpError } from './shared'

const P = 'OpenAI-compatible provider'

function res(status: number, body: string, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

describe('providerHttpError', () => {
  it('shows the provider\'s own message and the status for a rejected key', async () => {
    const err = await providerHttpError(
      P,
      res(401, JSON.stringify({ error: { message: 'Invalid API key', code: 401 }, detail: 'Invalid API key' })),
    )
    expect(err.message).toBe(`${P} rejected the API key (HTTP 401): Invalid API key`)
    expect(err.code).toBe('invalid_key')
    expect(err.status).toBe(401)
  })

  it('reads the other JSON shapes providers use', async () => {
    expect((await providerHttpError(P, res(401, JSON.stringify({ error: 'Bad key' })))).message).toContain(': Bad key')
    expect((await providerHttpError(P, res(403, JSON.stringify({ message: 'Forbidden here' })))).message).toContain(
      ': Forbidden here',
    )
    expect((await providerHttpError(P, res(401, JSON.stringify({ detail: 'API key required' })))).message).toContain(
      ': API key required',
    )
  })

  it('tells a proxy block page apart from a wrong key by showing its text', async () => {
    const html =
      '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title><style>body{color:red}</style></head>' +
      '<body><script>var x = 1</script><h1>Sorry, you have been blocked</h1></body></html>'
    const err = await providerHttpError(P, res(403, html, 'text/html'))
    expect(err.message).toContain('(HTTP 403)')
    expect(err.message).toContain('Attention Required! | Cloudflare')
    expect(err.message).toContain('Sorry, you have been blocked')
    expect(err.message).not.toContain('var x')
    expect(err.message).not.toContain('<')
    expect(err.code).toBe('invalid_key')
  })

  it('shortens a long body', async () => {
    const err = await providerHttpError(P, res(403, 'x'.repeat(500), 'text/plain'))
    expect(err.message.length).toBeLessThan(220)
    expect(err.message.endsWith('…')).toBe(true)
  })

  it('keeps just the status when the body is empty', async () => {
    const err = await providerHttpError(P, res(403, ''))
    expect(err.message).toBe(`${P} rejected the API key (HTTP 403)`)
  })

  it('falls back to a short piece of a JSON body that has no message', async () => {
    const err = await providerHttpError(P, res(401, JSON.stringify({ error: { code: 401 } })))
    expect(err.message).toContain('"code":401')
  })

  it('leaves the other statuses as they were', async () => {
    const limited = await providerHttpError(P, res(429, JSON.stringify({ error: { message: 'Slow down' } })))
    expect(limited.message).toBe(`${P} rate limit reached: Slow down`)
    expect(limited.code).toBe('rate_limited')
    expect(limited.status).toBe(502)

    const broken = await providerHttpError(P, res(500, JSON.stringify({ error: { message: 'Boom' } })))
    expect(broken.message).toBe(`${P} API error (500): Boom`)
    expect(broken.code).toBe('provider_error')
    expect(broken.status).toBe(502)
  })
})
