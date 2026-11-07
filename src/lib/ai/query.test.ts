import { describe, it, expect } from 'vitest'
import { latestUserMessage, knowledgeQuery } from './query'

describe('latestUserMessage', () => {
  it('returns the most recent user turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    ).toBe('latest')
  })

  it('falls back to the last message when none are user', () => {
    expect(
      latestUserMessage([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(latestUserMessage([])).toBe('')
  })
})

describe('knowledgeQuery', () => {
  it('joins the recent customer turns in order and skips assistant turns', () => {
    expect(
      knowledgeQuery([
        { role: 'user', content: 'mau ikut sertifikasi K3 umum' },
        { role: 'assistant', content: 'baik kak, silakan' },
        { role: 'user', content: 'berapa biayanya?' },
      ]),
    ).toBe('mau ikut sertifikasi K3 umum\nberapa biayanya?')
  })

  it('keeps only the last N customer turns', () => {
    const msgs = Array.from({ length: 15 }, (_, i) => ({
      role: 'user' as const,
      content: `pesan ${i + 1}`,
    }))
    const out = knowledgeQuery(msgs).split('\n')
    expect(out).toHaveLength(10)
    expect(out[0]).toBe('pesan 6')
    expect(out[9]).toBe('pesan 15')
  })

  it('honours a custom message count', () => {
    const msgs = [
      { role: 'user' as const, content: 'a' },
      { role: 'user' as const, content: 'b' },
      { role: 'user' as const, content: 'c' },
    ]
    expect(knowledgeQuery(msgs, 2)).toBe('b\nc')
  })

  it('caps the length, keeping the newest text', () => {
    const out = knowledgeQuery([
      { role: 'user', content: 'x'.repeat(3000) },
      { role: 'user', content: 'terbaru' },
    ])
    expect(out.length).toBe(2000)
    expect(out.endsWith('terbaru')).toBe(true)
  })

  it('falls back to the last message when there are no customer turns', () => {
    expect(
      knowledgeQuery([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(knowledgeQuery([])).toBe('')
  })
})
