// ============================================================
// GET    /api/v1/knowledge/{id} — read a document   (knowledge:read)
// PATCH  /api/v1/knowledge/{id} — update title/text (knowledge:write)
// DELETE /api/v1/knowledge/{id} — delete a document (knowledge:write)
//
// Account-scoped: a document in another account returns 404. PATCH
// re-indexes only when `content` changed. DELETE removes the chunks
// too (cascade).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';
import {
  KB_FULL_SELECT,
  KnowledgeInputError,
  parseContent,
  parseTitle,
  serializeKnowledge,
  indexDocument,
  type KnowledgeRow,
} from '@/lib/api/v1/knowledge';

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = () => fail('not_found', 'Document not found', 404);

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'knowledge:read');
    const { id } = await params;
    if (!isUuid(id)) return NOT_FOUND();

    const { data, error } = await ctx.supabase
      .from('ai_knowledge_documents')
      .select(KB_FULL_SELECT)
      .eq('account_id', ctx.accountId)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error('[api/v1/knowledge] read error:', error);
      return fail('internal', 'Failed to read document', 500);
    }
    if (!data) return NOT_FOUND();
    return ok(serializeKnowledge(data as KnowledgeRow));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'knowledge:write');
    const { id } = await params;
    if (!isUuid(id)) return NOT_FOUND();

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    let title: string | undefined;
    let content: string | undefined;
    try {
      title = parseTitle(body.title, false);
      content = parseContent(body.content, false);
    } catch (err) {
      if (err instanceof KnowledgeInputError) return fail('bad_request', err.message, 400);
      throw err;
    }
    if (title === undefined && content === undefined) {
      return fail('bad_request', "Send at least one of 'title' or 'content'", 400);
    }

    const update: Record<string, string> = { updated_at: new Date().toISOString() };
    if (title !== undefined) update.title = title;
    if (content !== undefined) update.content = content;

    const { data, error } = await ctx.supabase
      .from('ai_knowledge_documents')
      .update(update)
      .eq('account_id', ctx.accountId)
      .eq('id', id)
      .select(KB_FULL_SELECT)
      .maybeSingle();
    if (error) {
      console.error('[api/v1/knowledge] update error:', error);
      return fail('internal', 'Failed to update document', 500);
    }
    if (!data) return NOT_FOUND();

    const outcome =
      content !== undefined
        ? await indexDocument(ctx.supabase, ctx.accountId, id, content)
        : undefined;
    return ok({ ...serializeKnowledge(data as KnowledgeRow), ...(outcome ?? {}) });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await requireApiKey(request, 'knowledge:write');
    const { id } = await params;
    if (!isUuid(id)) return NOT_FOUND();

    const { data, error } = await ctx.supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) {
      console.error('[api/v1/knowledge] delete error:', error);
      return fail('internal', 'Failed to delete document', 500);
    }
    if (!data) return NOT_FOUND();
    return ok({ id, deleted: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
