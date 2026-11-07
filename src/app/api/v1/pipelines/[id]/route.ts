import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { id } = await context.params;
    if (!isUuid(id)) return fail('not_found', 'Pipeline not found', 404);
    const { data, error } = await ctx.supabase
      .from('pipelines')
      .select('id, name, account_id, created_at, pipeline_stages(id, name, position, color, created_at)')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error || !data) return fail('not_found', 'Pipeline not found', 404);
    const out = {
      ...data,
      pipeline_stages: Array.isArray((data as { pipeline_stages?: unknown[] }).pipeline_stages)
        ? [...((data as { pipeline_stages: Array<Record<string, unknown>> }).pipeline_stages)].sort(
            (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0)
          )
        : [],
    };
    return ok(out);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const { id } = await context.params;
    if (!isUuid(id)) return fail('not_found', 'Pipeline not found', 404);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      const { error } = await ctx.supabase
        .from('pipelines')
        .update({ name: body.name.trim() })
        .eq('id', id)
        .eq('account_id', ctx.accountId);
      if (error) return fail('internal', 'Failed to update pipeline', 500);
    }
    // Optional stage upsert.
    if (Array.isArray(body.stages)) {
      const rows = (body.stages as Array<Record<string, unknown>>).map((s, i) => ({
        id: typeof s.id === 'string' && isUuid(s.id) ? s.id : undefined,
        pipeline_id: id,
        name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `Stage ${i + 1}`,
        position: typeof s.position === 'number' ? s.position : i,
        color: typeof s.color === 'string' ? s.color : '#3b82f6',
      }));
      // Separate inserts/updates handled by upsert on id.
      await ctx.supabase.from('pipeline_stages').upsert(rows.filter((r) => r.id), { onConflict: 'id' });
      const newStages = rows.filter((r) => !r.id);
      if (newStages.length > 0) await ctx.supabase.from('pipeline_stages').insert(newStages);
    }

    const { data, error } = await ctx.supabase
      .from('pipelines')
      .select('id, name, account_id, created_at, pipeline_stages(id, name, position, color, created_at)')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error || !data) return fail('not_found', 'Pipeline not found', 404);
    const out = {
      ...data,
      pipeline_stages: Array.isArray((data as { pipeline_stages?: unknown[] }).pipeline_stages)
        ? [...((data as { pipeline_stages: Array<Record<string, unknown>> }).pipeline_stages)].sort(
            (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0)
          )
        : [],
    };
    return ok(out);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const { id } = await context.params;
    if (!isUuid(id)) return fail('not_found', 'Pipeline not found', 404);
    const { error } = await ctx.supabase.from('pipelines').delete().eq('id', id).eq('account_id', ctx.accountId);
    if (error) return fail('internal', 'Failed to delete pipeline', 500);
    return ok({ success: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}