// ============================================================
// GET  /api/v1/tags — list tags (scope: tags:read)
// POST /api/v1/tags — create a tag (scope: tags:write)
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tags:read');
    const { limit, cursor } = parseListParams(request);

    let query = ctx.supabase
      .from('tags')
      .select('id, name, color, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/tags] list error:', error);
      return fail('internal', 'Failed to list tags', 500);
    }
    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(items, nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('bad_request', "'name' is required", 400);
    const color = typeof body.color === 'string' && body.color.trim() ? body.color.trim() : '#3b82f6';

    const { data, error } = await ctx.supabase
      .from('tags')
      .insert({ user_id: ctx.createdBy, account_id: ctx.accountId, name, color })
      .select('id, name, color, created_at')
      .single();
    if (error || !data) {
      console.error('[api/v1/tags] insert error:', error);
      return fail('internal', 'Failed to create tag', 500);
    }
    return ok(data, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}