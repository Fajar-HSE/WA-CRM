import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

export interface IngestResult {
  keywordOnly: boolean
  embedError: unknown
}

const CHUNK_DELETE_BATCH = 100

/** How many KB excerpts go into each draft / auto-reply prompt. */
export const DEFAULT_KNOWLEDGE_EXCERPTS = 8

interface MatchRow {
  id: string
  content: string
}

/**
 * (Re)build the chunks for one document. Re-chunks the content and —
 * when the account has an embeddings key — embeds each chunk. Runs under
 * whatever client the caller passes (service-role for ingest routes).
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddings'>,
  documentId: string,
  content: string,
): Promise<IngestResult> {
  const chunks = chunkText(content)

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddings && chunks.length > 0) {
    try {
      embeddings = await embedTexts(config.embeddings, chunks)
    } catch (err) {
      embedError = err
    }
  }

  const { data: previousChunks, error: listErr } = await db
    .from('ai_knowledge_chunks')
    .select('id')
    .eq('document_id', documentId)
  if (listErr) throw listErr

  if (chunks.length > 0) {
    const rows = chunks.map((content, i) => ({
      document_id: documentId,
      account_id: accountId,
      chunk_index: i,
      content,
      embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
    }))
    const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
    if (insErr) throw insErr
  }

  const previousIds = (previousChunks ?? []).map((row: { id: string }) => row.id)
  for (let i = 0; i < previousIds.length; i += CHUNK_DELETE_BATCH) {
    const { error: delErr } = await db
      .from('ai_knowledge_chunks')
      .delete()
      .in('id', previousIds.slice(i, i + CHUNK_DELETE_BATCH))
    if (delErr) throw delErr
  }

  // Persist per-document stats so the dashboard can show chunk count and
  // whether semantic search is live for this doc. Best-effort: a failure
  // here must not discard the chunks we just stored — the toast in the
  // route already reports the real indexing outcome.
  const indexStatus =
    chunks.length === 0 ? 'lexical' : embeddings ? 'semantic' : 'lexical'
  try {
    const { error: statErr } = await db
      .from('ai_knowledge_documents')
      .update({ chunk_count: chunks.length, index_status: indexStatus })
      .eq('id', documentId)
    if (statErr) {
      console.error('[ai knowledge] failed to update doc stats:', statErr)
    }
  } catch (err) {
    console.error('[ai knowledge] failed to update doc stats:', err)
  }

  return { keywordOnly: embedError !== null, embedError }
}

/** Reciprocal-rank-fusion constant: higher = flatter weighting of ranks. */
const RRF_K = 60
/** Cap on the "focus" (latest customer message) query, in characters. */
const FOCUS_MAX_CHARS = 500

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Hybrid: every available ranking is fused with reciprocal-rank fusion,
 * so an excerpt that ranks well in ANY of them (meaning, or exact words
 * such as a price or a course code) reaches the prompt:
 *   - semantic, for the whole query (recent customer turns), and
 *   - semantic, for `focusText` (the latest customer message on its
 *     own), because a long multi-turn query blurs the topic,
 *   - lexical full-text, for the whole query.
 * Lexical-only when the account has no embeddings key. Best-effort: any
 * failure (no KB, embedding error, RPC error) degrades to fewer or zero
 * results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddings'>,
  queryText: string,
  k = DEFAULT_KNOWLEDGE_EXCERPTS,
  opts: { focusText?: string } = {},
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
  } catch {
    return []
  }

  // Each ranking is an ordered list of rows, best first.
  const rankings: MatchRow[][] = []

  // Semantic path: one embeddings call for all query texts.
  if (config.embeddings) {
    try {
      const focus = (opts.focusText ?? '').trim().slice(-FOCUS_MAX_CHARS)
      const texts = focus && focus !== query ? [query, focus] : [query]
      const vectors = await embedTexts(config.embeddings, texts)
      const lists = await Promise.all(
        vectors.map(async (vector) => {
          if (!vector) return [] as MatchRow[]
          const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
            p_account_id: accountId,
            p_query_embedding: toVectorLiteral(vector),
            p_match_count: k,
          })
          return !error && Array.isArray(data) ? (data as MatchRow[]) : []
        }),
      )
      // The focused ranking goes first: it breaks ties in favour of what
      // the customer just asked.
      for (const list of lists.reverse()) if (list.length > 0) rankings.push(list)
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical path (the sole path when there's no embeddings key). Always
  // part of the fusion: exact words still matter next to meaning.
  try {
    const { data, error } = await db.rpc('match_ai_knowledge_fts', {
      p_account_id: accountId,
      p_query: query,
      p_match_count: k,
    })
    if (!error && Array.isArray(data) && data.length > 0) rankings.push(data as MatchRow[])
  } catch (err) {
    console.error('[ai knowledge] lexical retrieval failed:', err)
  }

  return fuseRankings(rankings).slice(0, k)
}

/** Reciprocal-rank fusion over ordered lists of rows; returns contents. */
export function fuseRankings(rankings: { id: string; content: string }[][]): string[] {
  const scores = new Map<string, { content: string; score: number; first: number }>()
  let order = 0
  for (const list of rankings) {
    list.forEach((row, rank) => {
      const hit = scores.get(row.id)
      const add = 1 / (RRF_K + rank + 1)
      if (hit) hit.score += add
      else scores.set(row.id, { content: row.content, score: add, first: order++ })
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .map((v) => v.content)
}
