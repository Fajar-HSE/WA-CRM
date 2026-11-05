// ============================================================
// Public API (v1) knowledge-base helpers: input validation, row
// serialization and (re)indexing.
//
// The documents are the same rows the dashboard edits under
// Settings → AI assistant → Knowledge base; the AI draft and
// auto-reply features read their chunks. Every write here chunks the
// text (and embeds it when the account has an embeddings key) exactly
// as the dashboard routes do, so a document added over the API is
// searchable immediately.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { loadEmbeddingsKey } from '@/lib/ai/config';
import { ingestDocument } from '@/lib/ai/knowledge';
import { AiError } from '@/lib/ai/types';

export const KB_TITLE_MAX = 200;
/** Generous for a FAQ/policy page; bounds embedding spend per call. */
export const KB_CONTENT_MAX = 100_000;

export const KB_LIST_SELECT = 'id, title, created_at, updated_at';
export const KB_FULL_SELECT = 'id, title, content, created_at, updated_at';

export class KnowledgeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeInputError';
  }
}

/** Validate a title. `undefined` passes through when not required. */
export function parseTitle(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new KnowledgeInputError("'title' must be a non-empty string");
  }
  const title = value.trim();
  if (title.length > KB_TITLE_MAX) {
    throw new KnowledgeInputError(`'title' must be at most ${KB_TITLE_MAX} characters`);
  }
  return title;
}

/** Validate document text. `undefined` passes through when not required. */
export function parseContent(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new KnowledgeInputError("'content' must be a non-empty string");
  }
  const content = value.trim();
  if (content.length > KB_CONTENT_MAX) {
    throw new KnowledgeInputError(
      `'content' must be at most ${KB_CONTENT_MAX} characters; split it into several documents`
    );
  }
  return content;
}

export interface KnowledgeRow {
  id: string;
  title: string;
  content?: string;
  created_at: string;
  updated_at: string;
}

export function serializeKnowledge(row: KnowledgeRow): KnowledgeRow {
  const out: KnowledgeRow = {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (typeof row.content === 'string') out.content = row.content;
  return out;
}

/** List shape: never carries the text, whatever the row holds. */
export function serializeKnowledgeSummary(row: KnowledgeRow): KnowledgeRow {
  const { content: _content, ...rest } = serializeKnowledge(row);
  void _content;
  return rest;
}

export type IndexStatus = 'indexed' | 'keyword_only' | 'not_indexed';

export interface IndexOutcome {
  /**
   * `indexed`: chunks stored (and embedded when a key is configured).
   * `keyword_only`: chunks stored but embedding failed or its key is
   * unusable, so only keyword search finds it. `not_indexed`: chunking
   * failed; the document is saved but not searchable yet.
   */
  index_status: IndexStatus;
  warning?: string;
}

/**
 * (Re)build a document's chunks. Never throws: a saved document with a
 * failed index is still a saved document, so the caller reports the
 * outcome instead of rolling back.
 */
export async function indexDocument(
  db: SupabaseClient,
  accountId: string,
  documentId: string,
  content: string
): Promise<IndexOutcome> {
  const { key, corrupt } = await loadEmbeddingsKey(db, accountId);
  try {
    const result = await ingestDocument(
      db,
      accountId,
      { embeddingsApiKey: key },
      documentId,
      content
    );
    if (result.keywordOnly) {
      const reason =
        result.embedError instanceof AiError ? result.embedError.message : 'embedding failed';
      return {
        index_status: 'keyword_only',
        warning: `Saved, but semantic indexing failed (${reason}). Keyword search still works; re-index from Settings → AI assistant.`,
      };
    }
    if (corrupt) {
      return {
        index_status: 'keyword_only',
        warning:
          'Saved with keyword search only: the stored embeddings key cannot be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      };
    }
    return { index_status: 'indexed' };
  } catch (err) {
    console.error('[api/v1/knowledge] indexing failed:', err);
    return {
      index_status: 'not_indexed',
      warning:
        'Saved, but indexing failed, so the document is not searchable yet. Re-index from Settings → AI assistant.',
    };
  }
}
