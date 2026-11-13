/**
 * Starting points for the embeddings provider in Settings → Agen AI. They only
 * pre-fill the three fields; the admin can edit any of them, and saving
 * verifies the setup with a real request.
 *
 * `dimensions` is left empty on purpose: the knowledge-base column accepts any
 * vector size, so there is no need to force the model to a size it may not
 * support.
 */
export type EmbeddingPresetId = 'openai' | 'gemini' | 'jina' | 'custom'

export interface EmbeddingPreset {
  id: EmbeddingPresetId
  baseUrl: string
  model: string
}

export const EMBEDDING_PRESETS: Record<EmbeddingPresetId, EmbeddingPreset> = {
  // Blank base URL = OpenAI; the model falls back to text-embedding-3-small.
  openai: { id: 'openai', baseUrl: '', model: '' },
  gemini: {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-embedding-001',
  },
  jina: { id: 'jina', baseUrl: 'https://api.jina.ai/v1', model: 'jina-embeddings-v3' },
  custom: { id: 'custom', baseUrl: '', model: '' },
}

function sameUrl(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')
}

/** Which preset a stored base URL corresponds to (blank = OpenAI). */
export function presetForBaseUrl(baseUrl: string | null | undefined): EmbeddingPresetId {
  const value = (baseUrl ?? '').trim()
  if (!value) return 'openai'
  if (sameUrl(value, EMBEDDING_PRESETS.gemini.baseUrl)) return 'gemini'
  if (sameUrl(value, EMBEDDING_PRESETS.jina.baseUrl)) return 'jina'
  return 'custom'
}
