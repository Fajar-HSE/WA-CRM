import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';

const DEAL_SELECT =
  'id, pipeline_id, stage_id, contact_id, conversation_id, title, value, currency, notes, expected_close_date, status, created_at, updated_at';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { id } = await context.params;
    if (!isUuid(id)) return fail('not_found', 'Deal not found', 404);
    const { data, error } = await ctx.supabase
      .from('deals')
      .select(DEAL_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error || !data) return fail('not_found', 'Deal not found', 404);
    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const { id } = await context.params;
    if (!isUuid(id)) return fail('not_found', 'Deal not found', 404);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
    if (typeof body.stage_id === 'string' && isUuid(body.stage_id)) patch.stage_id = body.stage_id;
    if (typeof body.pipeline_id === 'string' && isUuid(body.pipeline_id)) patch.pipeline_id = body.pipeline_id;
    if (typeof body.value === 'number') patch.value = body.value;
    if (typeof body.currency === 'string' && body.currency.trim()) {
      const { data: acct } = await ctx.supabase
        .from('accounts')
        .select('default_currency')
        .eq('id', ctx.accountId)
        .maybeSingle();
      const accountCurrency = (acct?.default_currency as string | null) ?? 'IDR';
      const provided = body.currency.trim().toUpperCase();
      patch.currency = provided === accountCurrency ? provided : accountCurrency;
    }
    if (typeof body.notes === 'string') patch.notes = body.notes;
    if (body.notes === null) patch.notes = null;
    if (typeof body.expected_close_date === 'string') patch.expected_close_date = body.expected_close_date;
    if (body.expected_close_date === null) patch.expected_close_date = null;
    if (typeof body.status === 'string') patch.status = body.status;
    if (typeof body.contact_id === 'string' && isUuid(body.contact_id)) patch.contact_id = body.contact_id;
    if (body.contact_id === null) patch.contact_id = null;
    if (Object.keys(patch).length === 0) return fail('bad_request', 'Nothing to update', 400);
    patch.updated_at = new Date().toISOString();

    const { data, error } = await ctx.supabase
      .from('deals')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(DEAL_SELECT)
      .single();
    if (error || !data) return fail('not_found', 'Deal not found', 404);
    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const { id } = await context.params;
    if (!isUuid(id)) return fail('not_found', 'Deal not found', 404);
    const { error } = await ctx.supabase.from('deals').delete().eq('id', id).eq('account_id', ctx.accountId);
    if (error) return fail('internal', 'Failed to delete deal', 500);
    return ok({ success: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}