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
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-reindex:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: docs, error } = await supabase
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

    const total = (docs ?? []).length
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
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
