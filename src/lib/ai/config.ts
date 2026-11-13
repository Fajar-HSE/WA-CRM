import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig } from './types'
import type { EmbeddingsSettings } from './embeddings'

interface AiConfigRow {
  provider: 'openai' | 'anthropic' | 'openai_compatible'
  model: string
  base_url: string | null
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
  embeddings_base_url: string | null
  embeddings_model: string | null
  embeddings_dimensions: number | null
}

const CONFIG_COLUMNS =
  'provider, model, base_url, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key'

/** Columns added by migration 067 (embeddings from any provider). */
export const EMBEDDINGS_EXTRA_COLUMNS =
  'embeddings_base_url, embeddings_model, embeddings_dimensions'

export interface EmbeddingsExtraColumns {
  embeddings_base_url: string | null
  embeddings_model: string | null
  embeddings_dimensions: number | null
}

const EMBEDDINGS_EXTRA_DEFAULTS: EmbeddingsExtraColumns = {
  embeddings_base_url: null,
  embeddings_model: null,
  embeddings_dimensions: null,
}

/** PostgREST / Postgres "column does not exist". */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error &&
    (error.code === '42703' ||
      error.code === 'PGRST204' ||
      /column .* does not exist|could not find the .* column/i.test(error.message ?? ''))
  )
}

/**
 * Read the account's `ai_configs` row with `columns` plus the 067 columns.
 * Until migration 067 has been applied those columns do not exist; then the
 * read is retried without them and they come back null, so deploying the
 * code before the migration cannot take the AI assistant down.
 */
export async function fetchAiConfigRow<T extends Record<string, unknown>>(
  db: SupabaseClient,
  accountId: string,
  columns: string,
): Promise<{ data: (T & EmbeddingsExtraColumns) | null; error: { message: string } | null }> {
  const full = await db
    .from('ai_configs')
    .select(`${columns}, ${EMBEDDINGS_EXTRA_COLUMNS}`)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!isMissingColumn(full.error)) {
    return { data: full.data as unknown as (T & EmbeddingsExtraColumns) | null, error: full.error }
  }
  const legacy = await db.from('ai_configs').select(columns).eq('account_id', accountId).maybeSingle()
  return {
    data: legacy.data
      ? ({ ...(legacy.data as unknown as T), ...EMBEDDINGS_EXTRA_DEFAULTS })
      : null,
    error: legacy.error,
  }
}

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const { data, error } = await fetchAiConfigRow<Record<string, unknown>>(db, accountId, CONFIG_COLUMNS)

  if (error) throw error
  if (!data) return null

  const row = data as unknown as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddings: EmbeddingsSettings | null = null
  if (row.embeddings_api_key) {
    try {
      embeddings = embeddingsSettingsFrom(row, decrypt(row.embeddings_api_key))
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddings = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddings,
  }
}

/** Embeddings settings from a config row and its decrypted key. */
function embeddingsSettingsFrom(
  row: Pick<AiConfigRow, 'embeddings_base_url' | 'embeddings_model' | 'embeddings_dimensions'>,
  apiKey: string,
): EmbeddingsSettings {
  return {
    apiKey,
    baseUrl: row.embeddings_base_url?.trim() || null,
    model: row.embeddings_model?.trim() || null,
    dimensions: row.embeddings_dimensions ?? null,
  }
}

/**
 * Load + decrypt just the embeddings settings, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ settings, corrupt }`: `settings` is null when there's no key OR
 * it can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<{ settings: EmbeddingsSettings | null; corrupt: boolean }> {
  const { data, error } = await fetchAiConfigRow<Record<string, unknown>>(
    db,
    accountId,
    'embeddings_api_key',
  )
  if (error || !data?.embeddings_api_key) return { settings: null, corrupt: false }
  try {
    return {
      settings: embeddingsSettingsFrom(
        data as Pick<AiConfigRow, 'embeddings_base_url' | 'embeddings_model' | 'embeddings_dimensions'>,
        decrypt(data.embeddings_api_key as string),
      ),
      corrupt: false,
    }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { settings: null, corrupt: true }
  }
}
