import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Seed AI defaults for freshly registered workspace accounts.
//
// A `workspace` invitation creates a brand-new account (see
// POST /api/invitations/[token]/register) that starts with an empty
// `ai_configs` row-set and an empty knowledge base. To spare every new
// workspace the setup, we copy the AI config (provider, model, key
// ciphertext, system prompt) and the full knowledge base (documents +
// their pre-chunked retrieval units) from a template account.
//
// Why copy chunks instead of re-ingesting: chunkText + embedTexts would
// cost one embedding API round-trip per chunk on the new account's key
// and slow registration down by minutes. The rows are pure data, so a
// direct copy is instant and keeps hybrid search (FTS + optional
// semantic) working from the first login.
//
// Best-effort by contract: callers wrap this in try/catch — a failed
// seed must never fail the registration itself.
// ============================================================

/**
 * Account whose AI config + knowledge base seed every new workspace.
 * Override per deployment with `AI_SEED_TEMPLATE_ACCOUNT_ID`.
 */
const DEFAULT_TEMPLATE_ACCOUNT_ID = '893a144a-2f11-406f-80ab-13798510b057'

/** Docs per insert batch — keeps each request well under payload limits. */
export const AI_SEED_DOC_BATCH = 20
/** Chunks per insert batch (a chunk can be a few KB of text). */
export const AI_SEED_CHUNK_BATCH = 100
/** Read page sizes from the template account. */
const DOC_PAGE = 100
const CHUNK_PAGE = 1000

export interface SeedAiDefaultsResult {
  /** True when at least one row was copied. */
  seeded: boolean
  /** Why nothing was copied (only set when seeded is false). */
  reason?: 'already-configured' | 'no-template'
  documents: number
  chunks: number
}

export function templateAccountId(): string {
  return process.env.AI_SEED_TEMPLATE_ACCOUNT_ID?.trim() || DEFAULT_TEMPLATE_ACCOUNT_ID
}

/** Identity key for matching a template doc to its inserted copy. */
function docKey(title: string, content: string): string {
  return `${title} ${content}`
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : JSON.stringify(err)
}

/**
 * Copy the template account's AI config + knowledge base into
 * `targetAccountId`. Each half is guarded independently, so a partial
 * previous attempt (config copied, KB failed) resumes where it left off
 * instead of duplicating rows.
 *
 * `createdBy` is stamped on every inserted row (NOT NULL columns).
 */
export async function seedAiDefaults(
  db: SupabaseClient,
  targetAccountId: string,
  createdBy: string,
): Promise<SeedAiDefaultsResult> {
  const templateId = templateAccountId()

  // ---- guards: what does the target already have? ----------------
  const { data: existingConfig, error: guardCfgErr } = await db
    .from('ai_configs')
    .select('id')
    .eq('account_id', targetAccountId)
    .maybeSingle()
  if (guardCfgErr) throw new Error(`seed guard (config): ${message(guardCfgErr)}`)

  const { count: existingDocs, error: guardDocErr } = await db
    .from('ai_knowledge_documents')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', targetAccountId)
  if (guardDocErr) throw new Error(`seed guard (docs): ${message(guardDocErr)}`)

  const needConfig = !existingConfig
  const needKb = !existingDocs

  if (!needConfig && !needKb) {
    return { seeded: false, reason: 'already-configured', documents: 0, chunks: 0 }
  }
  if (templateId === targetAccountId) {
    return { seeded: false, reason: 'no-template', documents: 0, chunks: 0 }
  }

  let documents = 0
  let chunks = 0
  let templateFound = false

  // ---- 1. AI config ----------------------------------------------
  if (needConfig) {
    const { data: tpl, error: tplErr } = await db
      .from('ai_configs')
      .select('*')
      .eq('account_id', templateId)
      .maybeSingle()
    if (tplErr) throw new Error(`seed template config: ${message(tplErr)}`)

    if (tpl) {
      templateFound = true
      const { error: insErr } = await db.from('ai_configs').insert({
        account_id: targetAccountId,
        created_by: createdBy,
        provider: tpl.provider,
        model: tpl.model,
        api_key: tpl.api_key,
        system_prompt: tpl.system_prompt,
        is_active: tpl.is_active,
        auto_reply_enabled: tpl.auto_reply_enabled,
        auto_reply_max_per_conversation: tpl.auto_reply_max_per_conversation,
        embeddings_api_key: tpl.embeddings_api_key,
        base_url: tpl.base_url,
        // The template's handoff agent is a user of the template account
        // and does not exist in the new one — start with no handoff target.
        handoff_agent_id: null,
      })
      if (insErr) throw new Error(`seed config insert: ${message(insErr)}`)
    }
  }

  // ---- 2. knowledge base (documents, then chunks) -----------------
  if (needKb) {
    /** old template doc id -> new doc id in the target account */
    const idMap = new Map<string, string>()

    for (let from = 0; ; from += DOC_PAGE) {
      const { data: docs, error: listErr } = await db
        .from('ai_knowledge_documents')
        .select('id, title, content')
        .eq('account_id', templateId)
        .order('created_at', { ascending: true })
        .range(from, from + DOC_PAGE - 1)
      if (listErr) throw new Error(`seed list docs: ${message(listErr)}`)
      if (!docs || docs.length === 0) break
      if (from === 0) templateFound = true

      for (let i = 0; i < docs.length; i += AI_SEED_DOC_BATCH) {
        const batch = docs.slice(i, i + AI_SEED_DOC_BATCH)
        const { data: inserted, error: insErr } = await db
          .from('ai_knowledge_documents')
          .insert(
            batch.map((d) => ({
              account_id: targetAccountId,
              created_by: createdBy,
              title: d.title,
              content: d.content,
            })),
          )
          .select('id, title, content')
        if (insErr) throw new Error(`seed docs insert: ${message(insErr)}`)

        // Pool the returned ids per identity key so even byte-identical
        // duplicate docs map one-to-one instead of collapsing.
        const pool = new Map<string, string[]>()
        for (const row of inserted ?? []) {
          const key = docKey(row.title, row.content)
          pool.set(key, [...(pool.get(key) ?? []), row.id])
        }
        for (const old of batch) {
          const newId = pool.get(docKey(old.title, old.content))?.shift()
          if (newId) idMap.set(old.id, newId)
        }
        documents += batch.length
      }
      if (docs.length < DOC_PAGE) break
    }

    if (documents > 0) {
      for (let from = 0; ; from += CHUNK_PAGE) {
        const { data: rows, error: listErr } = await db
          .from('ai_knowledge_chunks')
          .select('document_id, chunk_index, content, embedding')
          .eq('account_id', templateId)
          .order('document_id', { ascending: true })
          .order('chunk_index', { ascending: true })
          .range(from, from + CHUNK_PAGE - 1)
        if (listErr) throw new Error(`seed list chunks: ${message(listErr)}`)
        if (!rows || rows.length === 0) break

        const mapped = rows
          .filter((r) => idMap.has(r.document_id))
          .map((r) => ({
            document_id: idMap.get(r.document_id)!,
            account_id: targetAccountId,
            chunk_index: r.chunk_index,
            content: r.content,
            embedding: r.embedding,
          }))

        for (let i = 0; i < mapped.length; i += AI_SEED_CHUNK_BATCH) {
          const { error: insErr } = await db
            .from('ai_knowledge_chunks')
            .insert(mapped.slice(i, i + AI_SEED_CHUNK_BATCH))
          if (insErr) throw new Error(`seed chunks insert: ${message(insErr)}`)
        }
        chunks += mapped.length

        if (rows.length < CHUNK_PAGE) break
      }
    }
  }

  if (!templateFound) {
    return { seeded: false, reason: 'no-template', documents: 0, chunks: 0 }
  }

  return { seeded: true, documents, chunks }
}
