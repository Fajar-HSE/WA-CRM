import { AiError } from './types'
import { aiRequestTimeoutMs } from './defaults'
import { providerHttpError, toNetworkError } from './providers/shared'
import { allowedPrivateHosts, validateHttpBaseUrl } from './providers/openai-compatible'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ============================================================
// Embeddings (any OpenAI-compatible provider).
//
// Used for the knowledge base's optional semantic-search path: embed
// each chunk at ingest, and embed the query at retrieval. Anthropic has
// no embeddings endpoint, so this is a separate, optional provider: OpenAI
// by default, or any service that speaks the OpenAI `/embeddings` format
// (Google Gemini's compatibility endpoint, Jina, a self-hosted server...).
// The account supplies a (possibly separate) key, and optionally a base
// URL, a model and a vector size.
//
// The column type is an unconstrained pgvector `vector` (migration 067),
// so any size works. Vectors of different models cannot be compared:
// changing the model means Reindex (the database skips vectors whose size
// differs from the question's, so nothing errors in the meantime).
// ============================================================

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'

/** Where the endpoint of an account's embeddings provider is read from. */
export interface EmbeddingsSettings {
  apiKey: string
  /** OpenAI-compatible base URL (e.g. https://host/v1). Null = OpenAI. */
  baseUrl: string | null
  /** Model id. Null = text-embedding-3-small (OpenAI only). */
  model: string | null
  /** Vector size to request (`dimensions`). Null = the model's own size. */
  dimensions: number | null
}

// OpenAI accepts an array input; keep batches modest so a big re-index
// stays under request-size limits and partial failures are cheap.
const BATCH_SIZE = 96

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[]
}

/**
 * The `/embeddings` URL for these settings. A blank base URL means OpenAI.
 * Anything else goes through the same checks as a custom chat provider
 * (https only, no credentials in the URL, private hosts only when
 * allow-listed), and a trailing `/embeddings` is accepted.
 */
export function embeddingsEndpoint(baseUrl: string | null | undefined): string {
  const value = (baseUrl ?? '').trim()
  if (!value) return OPENAI_EMBEDDINGS_URL
  const base = validateHttpBaseUrl(value).replace(/\/embeddings$/, '')
  return `${base}/embeddings`
}

/** Format a vector for a pgvector column / RPC param: `[0.1,0.2,...]`.
 *  PostgREST casts this text literal to `vector`; a raw JS array does
 *  not cast reliably. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Embed a list of strings, preserving input order. Batched; throws
 * `AiError` on provider/network failure so callers can decide whether
 * to degrade (retrieval) or surface (ingest).
 */
export async function embedTexts(
  settings: EmbeddingsSettings,
  inputs: string[],
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const timeoutMs = aiRequestTimeoutMs()

  const custom = !!(settings.baseUrl ?? '').trim()
  const model = (settings.model ?? '').trim() || (custom ? '' : DEFAULT_EMBEDDING_MODEL)
  if (!model) {
    throw new AiError(t('ai.embeddingsModelRequired'), {
      code: 'embeddings_model_required',
      status: 400,
    })
  }

  const endpoint = embeddingsEndpoint(settings.baseUrl)
  if (custom) {
    let deliverable = false
    try {
      deliverable = await isDeliverableUrl(endpoint, {
        allowPrivateHosts: allowedPrivateHosts(),
      })
    } catch {
      deliverable = false
    }
    if (!deliverable) {
      throw new AiError(t('ai.compatBlockedUrl', { envVar: 'AI_PROVIDER_ALLOWED_PRIVATE_HOSTS' }), {
        code: 'blocked_url',
        status: 400,
      })
    }
  }

  const out: number[][] = []

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)

    const body: Record<string, unknown> = { model, input: batch }
    if (settings.dimensions) body.dimensions = settings.dimensions

    let res: Response
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        // A redirect could carry the key to another host.
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }

    if (!res.ok) {
      throw await providerHttpError('Embeddings provider', res)
    }

    const data = (await res.json().catch(() => null)) as EmbeddingResponse | null
    const rows = data?.data
    if (!rows || rows.length !== batch.length) {
      throw new AiError(t('ai.embeddingsMalformed'), {
        code: 'embeddings_malformed',
      })
    }

    // Sort by index so order matches the input batch regardless of how
    // the provider returns them. Require a real numeric index — defaulting
    // a missing one to 0 would silently misalign chunks with their
    // vectors (chunk N gets chunk M's embedding), so fail loud instead.
    if (rows.some((r) => typeof r.index !== 'number')) {
      throw new AiError(t('ai.embeddingsMissingIndices'), {
        code: 'embeddings_malformed',
      })
    }
    const ordered = [...rows].sort((a, b) => a.index! - b.index!)
    for (const r of ordered) {
      if (!Array.isArray(r.embedding) || r.embedding.length === 0) {
        throw new AiError(t('ai.embeddingsMissingVector'), {
          code: 'embeddings_malformed',
        })
      }
      out.push(r.embedding)
    }
  }

  // Every vector must have the same size, and the size the admin asked for
  // when they asked for one: a provider that ignores `dimensions` would
  // otherwise store vectors that cannot be compared with each other later.
  const size = out[0].length
  if (out.some((v) => v.length !== size)) {
    throw new AiError(t('ai.embeddingsInconsistent'), { code: 'embeddings_malformed' })
  }
  if (settings.dimensions && size !== settings.dimensions) {
    throw new AiError(t('ai.embeddingsDimMismatch', { expected: settings.dimensions, got: size }), {
      code: 'embeddings_dimension_mismatch',
      status: 400,
    })
  }

  return out
}
