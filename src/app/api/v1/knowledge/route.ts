// ============================================================
// GET  /api/v1/knowledge — list documents   (scope: knowledge:read)
// POST /api/v1/knowledge — create a document (scope: knowledge:write)
//
// The list omits `content` (fetch one document for the full text).
// POST chunks and indexes the text so the AI assistant can use it at
// once. With `"replace_existing": true`, a document with the same
// title is updated in place instead of duplicated, which makes a
// re-run of an import idempotent.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';
import {
  KB_LIST_SELECT,
  KB_FULL_SELECT,
  KnowledgeInputError,
  parseContent,
  parseTitle,
  serializeKnowledge,
  serializeKnowledgeSummary,
  indexDocument,
  type KnowledgeRow,
} from '@/lib/api/v1/knowledge';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'knowledge:read');
    const { limit, cursor } = parseListParams(request);

    let query = ctx.supabase
      .from('ai_knowledge_documents')
      .select(KB_LIST_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/knowledge] list error:', error);
      return fail('internal', 'Failed to list documents', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) => serializeKnowledgeSummary(r as unknown as KnowledgeRow)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'knowledge:write');

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    let title: string;
    let content: string;
    try {
      title = parseTitle(body.title, true) as string;
      content = parseContent(body.content, true) as string;
    } catch (err) {
      if (err instanceof KnowledgeInputError) return fail('bad_request', err.message, 400);
      throw err;
    }
    if (
      body.replace_existing !== undefined &&
      typeof body.replace_existing !== 'boolean'
    ) {
      return fail('bad_request', "'replace_existing' must be a boolean", 400);
    }

    // Same-title lookup (exact, case-insensitive) for the idempotent path.
    if (body.replace_existing === true) {
      const { data: existing, error: findErr } = await ctx.supabase
        .from('ai_knowledge_documents')
        .select('id')
        .eq('account_id', ctx.accountId)
        .ilike('title', escapeLike(title))
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (findErr) {
        console.error('[api/v1/knowledge] lookup error:', findErr);
        return fail('internal', 'Failed to save document', 500);
      }
      if (existing) {
        const { data: updated, error: updErr } = await ctx.supabase
          .from('ai_knowledge_documents')
          .update({ title, content, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
          .eq('account_id', ctx.accountId)
          .select(KB_FULL_SELECT)
          .single();
        if (updErr || !updated) {
          console.error('[api/v1/knowledge] replace error:', updErr);
          return fail('internal', 'Failed to save document', 500);
        }
        const outcome = await indexDocument(ctx.supabase, ctx.accountId, existing.id, content);
        return ok({ ...serializeKnowledge(updated as KnowledgeRow), created: false, ...outcome }, 200);
      }
    }

    const { data: doc, error } = await ctx.supabase
      .from('ai_knowledge_documents')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.createdBy,
        title,
        content,
      })
      .select(KB_FULL_SELECT)
      .single();
    if (error || !doc) {
      console.error('[api/v1/knowledge] insert error:', error);
      return fail('internal', 'Failed to save document', 500);
    }

    const outcome = await indexDocument(ctx.supabase, ctx.accountId, doc.id, content);
    return ok({ ...serializeKnowledge(doc as KnowledgeRow), created: true, ...outcome }, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

/** Escape `%`, `_` and `\` so `ilike` matches the title literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
