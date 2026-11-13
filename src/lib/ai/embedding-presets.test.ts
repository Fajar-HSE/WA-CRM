import { describe, expect, it } from 'vitest'

import { EMBEDDING_PRESETS, presetForBaseUrl } from './embedding-presets'

describe('presetForBaseUrl', () => {
  it('treats a blank URL as OpenAI', () => {
    expect(presetForBaseUrl(null)).toBe('openai')
    expect(presetForBaseUrl('')).toBe('openai')
    expect(presetForBaseUrl('   ')).toBe('openai')
  })

  it('recognises the other presets, ignoring a trailing slash', () => {
    expect(presetForBaseUrl(EMBEDDING_PRESETS.gemini.baseUrl)).toBe('gemini')
    expect(presetForBaseUrl(`${EMBEDDING_PRESETS.jina.baseUrl}/`)).toBe('jina')
  })

  it('calls anything else custom', () => {
    expect(presetForBaseUrl('https://embeddings.example.com/v1')).toBe('custom')
  })

  it('has an https base URL and a model for every hosted preset', () => {
    for (const id of ['gemini', 'jina'] as const) {
      expect(EMBEDDING_PRESETS[id].baseUrl).toMatch(/^https:\/\//)
      expect(EMBEDDING_PRESETS[id].model).not.toBe('')
    }
  })
})
