import { logError } from '@/lib/logging/error-log'
import { cleanMessage } from '@/lib/logging/sanitize'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsSettings } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/knowledge/reindex  (admin+)
 *
 * Re-chunk and re-embed every document in the account. The main use is
 * after adding an embeddings key: existing documents were stored
 * lexical-only, and this backfills their vectors so semantic search
 * turns on. Also recovers documents whose indexing failed earlier.
 */
export const maxDuration = 60

/** Stop starting new documents after this long, so the request ends with a
 *  clear answer before the platform's time limit cuts it off. */
const TIME_BUDGET_MS = 48_000
/** Small pause between documents: free-tier embeddings providers limit
 *  how fast requests may arrive. */
const PAUSE_BETWEEN_DOCS_MS = Number(process.env.AI_REINDEX_PAUSE_MS ?? 250)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function POST(request?: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-reindex:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    // Continue an unfinished run: only documents that are still waiting,
    // i.e. whose chunks are older than the run's start or have no vector.
    let since: string | null = null
    try {
      const body = request ? ((await request.json()) as { since?: unknown }) : null
      if (typeof body?.since === 'string' && !Number.isNaN(Date.parse(body.since))) {
        since = new Date(body.since).toISOString()
      }
    } catch {
      // No body: a normal full run.
    }
    const startedAt = since ?? new Date().toISOString()

    const { data: allDocs, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, content')
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/knowledge/reindex] fetch error:', error)
      return NextResponse.json(
        { error: t('ai.knowledge.loadDocsFailed') },
        { status: 500 },
      )
    }

    const { settings: embeddings, corrupt } = await loadEmbeddingsSettings(
      supabase,
      accountId,
    )
    // The whole point of Reindex is usually to backfill embeddings — so
    // if a key is configured but can't be decrypted, don't quietly do a
    // lexical-only pass and report success. Stop and tell the admin.
    if (corrupt) {
      return NextResponse.json(
        {
          success: false,
          reindexed: 0,
          error:
            t('ai.knowledge.reindexKeyCorrupt'),
        },
        { status: 200 },
      )
    }

    let docs = allDocs
    if (since) {
      const { data: waiting, error: waitErr } = await supabase
        .from('ai_knowledge_chunks')
        .select('document_id')
        .eq('account_id', accountId)
        .or(`embedding.is.null,created_at.lt.${since}`)
        .limit(10000)
      if (waitErr) {
        console.error('[ai/knowledge/reindex] resume lookup error:', waitErr)
        return NextResponse.json({ error: t('ai.knowledge.loadDocsFailed') }, { status: 500 })
      }
      const ids = new Set((waiting ?? []).map((r: { document_id: string }) => r.document_id))
      docs = (allDocs ?? []).filter((d: { id: string }) => ids.has(d.id))
    }

    const total = (docs ?? []).length
    const startedMs = Date.now()
    let timedOut = false
    let reindexed = 0
    const failed: string[] = []
    const keywordOnly: string[] = []
    let embedError: string | null = null
    let consecutiveEmbedFailures = 0
    let skipped = 0
    for (const doc of docs ?? []) {
      // The provider refused the first few documents: it will refuse the
      // rest too (wrong key, URL or model). Stop instead of making dozens
      // of calls that cannot work, and say why.
      if (consecutiveEmbedFailures >= 3) {
        skipped += 1
        continue
      }
      if (Date.now() - startedMs > TIME_BUDGET_MS) {
        timedOut = true
        skipped += 1
        continue
      }
      if (embeddings && reindexed + failed.length > 0) await sleep(PAUSE_BETWEEN_DOCS_MS)
      try {
        const result = await ingestDocument(supabase, accountId, { embeddings }, doc.id, doc.content)
        reindexed += 1
        if (result.keywordOnly) {
          keywordOnly.push(doc.id)
          consecutiveEmbedFailures += 1
          embedError ??= cleanMessage(result.embedError)
          await logError('ai.reindex', result.embedError, { accountId, level: 'warning', context: { documentId: doc.id, stage: 'embed' } })
        } else {
          consecutiveEmbedFailures = 0
        }
      } catch (err) {
        failed.push(doc.id)
        await logError('ai.reindex', err, { accountId, context: { documentId: doc.id, stage: 'ingest' } })
      }
    }

    return NextResponse.json({
      success: failed.length === 0,
      reindexed,
      total,
      failed,
      keyword_only: keywordOnly,
      embed_error: embedError,
      skipped,
      timed_out: timedOut,
      started_at: startedAt,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
