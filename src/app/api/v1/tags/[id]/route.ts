import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'tags:read');
    const { id } = await context.params;
    if (!isUuid(id)) return fail('not_found', 'Tag not found', 404);
    const { data, error } = await ctx.supabase
      .from('tags')
      .select('id, name, color, created_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error || !data) return fail('not_found', 'Tag not found', 404);
    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');
    const { id } = await context.params;
    if (!isUuid(id)) return fail('not_found', 'Tag not found', 404);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.color === 'string' && body.color.trim()) patch.color = body.color.trim();
    if (Object.keys(patch).length === 0) return fail('bad_request', 'Nothing to update', 400);

    const { data, error } = await ctx.supabase
      .from('tags')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id, name, color, created_at')
      .single();
    if (error || !data) return fail('not_found', 'Tag not found', 404);
    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');
    const { id } = await context.params;
    if (!isUuid(id)) return fail('not_found', 'Tag not found', 404);
    const { error } = await ctx.supabase.from('tags').delete().eq('id', id).eq('account_id', ctx.accountId);
    if (error) return fail('internal', 'Failed to delete tag', 500);
    return ok({ success: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}