import { NextResponse } from 'next/server'

import { isUuid } from '@/lib/api/v1/pagination'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { createWhatsAppProvider } from '@/lib/whatsapp/providers'
import { WahaHttpError, WahaStoreDisabledError, WahaWhatsAppProvider } from '@/lib/whatsapp/providers/waha'
import { HistoryImportError, importChatHistory } from '@/lib/whatsapp/waha-history'
import type { WhatsAppConfig } from '@/types'

const t = getT('Api')

const PAGE = 100

/**
 * POST /api/whatsapp/history  (agent+)
 * Body: { conversation_id: string, offset?: number }
 *
 * Copies one page of older messages of this chat from WAHA into the CRM, so
 * a conversation can show what was said before the CRM was connected.
 * Repeat with the returned `next_offset` to go further back.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`wa-history:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      conversation_id?: unknown
      offset?: unknown
    } | null
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    if (!isUuid(conversationId)) {
      return NextResponse.json({ error: t('history.invalidConversation') }, { status: 400 })
    }
    const offset =
      typeof body?.offset === 'number' && Number.isFinite(body.offset) && body.offset > 0
        ? Math.floor(body.offset)
        : 0

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()
    const provider = config ? createWhatsAppProvider(config as WhatsAppConfig) : null
    if (!(provider instanceof WahaWhatsAppProvider)) {
      return NextResponse.json({ error: t('history.notWaha') }, { status: 400 })
    }

    // The conversation is looked up with the caller's own client first, so
    // row-level security decides whether they may touch it at all.
    const { data: visible } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!visible) {
      return NextResponse.json({ error: t('history.invalidConversation') }, { status: 404 })
    }

    try {
      const result = await importChatHistory({
        db: supabaseAdmin(),
        accountId,
        conversationId,
        provider,
        limit: PAGE,
        offset,
      })
      return NextResponse.json({
        fetched: result.fetched,
        imported: result.imported,
        skipped: result.skipped,
        has_more: result.hasMore,
        next_offset: offset + result.fetched,
      })
    } catch (err) {
      if (err instanceof WahaStoreDisabledError) {
        return NextResponse.json(
          { error: t('history.storeDisabled'), code: 'history_store_disabled' },
          { status: 409 },
        )
      }
      if (err instanceof HistoryImportError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      if (err instanceof WahaHttpError) {
        console.error('[whatsapp/history] WAHA error:', err.message)
        return NextResponse.json({ error: t('history.wahaFailed') }, { status: 502 })
      }
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
