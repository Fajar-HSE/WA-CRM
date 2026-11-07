import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { limit, cursor } = parseListParams(request);

    let query = ctx.supabase
      .from('pipelines')
      .select('id, name, account_id, created_at, pipeline_stages(id, name, position, color, created_at)')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/pipelines] list error:', error);
      return fail('internal', 'Failed to list pipelines', 500);
    }
    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    // Sort stages by position within each pipeline.
    const out = (items as unknown as Array<Record<string, unknown>>).map((p) => ({
      ...p,
      pipeline_stages: Array.isArray(p.pipeline_stages)
        ? [...(p.pipeline_stages as Array<Record<string, unknown>>)].sort(
            (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0)
          )
        : [],
    }));
    return okList(out, nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('bad_request', "'name' is required", 400);

    const { data: pipeline, error } = await ctx.supabase
      .from('pipelines')
      .insert({ user_id: ctx.createdBy, account_id: ctx.accountId, name })
      .select('id, name, account_id, created_at')
      .single();
    if (error || !pipeline) {
      console.error('[api/v1/pipelines] insert error:', error);
      return fail('internal', 'Failed to create pipeline', 500);
    }

    // Optional initial stages.
    const stages = Array.isArray(body.stages) ? body.stages : [];
    if (stages.length > 0) {
      const rows = stages.map((s: unknown, i: number) => {
        const st = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
        return {
          pipeline_id: pipeline.id,
          name: typeof st.name === 'string' && st.name.trim() ? st.name.trim() : `Stage ${i + 1}`,
          position: typeof st.position === 'number' ? st.position : i,
          color: typeof st.color === 'string' ? st.color : '#3b82f6',
        };
      });
      await ctx.supabase.from('pipeline_stages').insert(rows);
    }

    // Return with stages.
    const { data: full } = await ctx.supabase
      .from('pipelines')
      .select('id, name, account_id, created_at, pipeline_stages(id, name, position, color, created_at)')
      .eq('id', pipeline.id)
      .single();
    return ok(full ?? pipeline, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}