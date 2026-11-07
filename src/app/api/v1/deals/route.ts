import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';
import { isUuid } from '@/lib/api/v1/pagination';

const DEAL_SELECT =
  'id, pipeline_id, stage_id, contact_id, conversation_id, title, value, currency, notes, expected_close_date, status, created_at, updated_at';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const pipelineId = url.searchParams.get('pipeline_id');
    const stageId = url.searchParams.get('stage_id');
    const status = url.searchParams.get('status');

    let query = ctx.supabase
      .from('deals')
      .select(DEAL_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (pipelineId && isUuid(pipelineId)) query = query.eq('pipeline_id', pipelineId);
    if (stageId && isUuid(stageId)) query = query.eq('stage_id', stageId);
    if (status) query = query.eq('status', status);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/deals] list error:', error);
      return fail('internal', 'Failed to list deals', 500);
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
    const ctx = await requireApiKey(request, 'deals:write');

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return fail('bad_request', "'title' is required", 400);
    const pipelineId = typeof body.pipeline_id === 'string' ? body.pipeline_id : '';
    const stageId = typeof body.stage_id === 'string' ? body.stage_id : '';
    if (!pipelineId || !isUuid(pipelineId)) return fail('bad_request', "'pipeline_id' must be a UUID", 400);
    if (!stageId || !isUuid(stageId)) return fail('bad_request', "'stage_id' must be a UUID", 400);

    // Verify pipeline belongs to account.
    const { data: pipeline } = await ctx.supabase
      .from('pipelines')
      .select('id')
      .eq('id', pipelineId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!pipeline) return fail('bad_request', 'Pipeline not found in this account', 400);

    const contactId = typeof body.contact_id === 'string' && isUuid(body.contact_id) ? body.contact_id : null;
    if (!contactId) return fail('bad_request', "'contact_id' is required (UUID)", 400);
    const conversationId = typeof body.conversation_id === 'string' && isUuid(body.conversation_id) ? body.conversation_id : null;

    const { data, error } = await ctx.supabase
      .from('deals')
      .insert({
        user_id: ctx.createdBy,
        account_id: ctx.accountId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        contact_id: contactId,
        conversation_id: conversationId,
        title,
        value: typeof body.value === 'number' ? body.value : 0,
        currency: typeof body.currency === 'string' ? body.currency : 'USD',
        notes: typeof body.notes === 'string' ? body.notes : null,
        expected_close_date: typeof body.expected_close_date === 'string' ? body.expected_close_date : null,
        status: typeof body.status === 'string' ? body.status : 'open',
      })
      .select(DEAL_SELECT)
      .single();
    if (error || !data) {
      console.error('[api/v1/deals] insert error:', error);
      return fail('internal', 'Failed to create deal', 500);
    }
    return ok(data, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}