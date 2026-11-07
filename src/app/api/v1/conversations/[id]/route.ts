// ============================================================
// GET /api/v1/conversations/{id} — read one conversation
// (scope: conversations:read). Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { isUuid } from '@/lib/api/v1/pagination';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;
    if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);

    const { data, error } = await ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);

    return ok(serializeConversation(normalizeConversation(data as Conversation)));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write');
    const { id } = await params;
    if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.status === 'string' && ['open', 'pending', 'closed'].includes(body.status)) {
      patch.status = body.status;
    }
    if (body.assigned_agent_id === null) {
      patch.assigned_agent_id = null;
    } else if (typeof body.assigned_agent_id === 'string' && isUuid(body.assigned_agent_id)) {
      patch.assigned_agent_id = body.assigned_agent_id;
    }
    if (typeof body.unread_count === 'number' && body.unread_count >= 0) {
      patch.unread_count = Math.floor(body.unread_count);
    }
    if (Object.keys(patch).length === 0) {
      return fail('bad_request', 'Nothing to update', 400);
    }
    patch.updated_at = new Date().toISOString();

    const { data, error } = await ctx.supabase
      .from('conversations')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(CONVERSATION_SELECT)
      .single();

    if (error || !data) return fail('not_found', 'Conversation not found', 404);
    return ok(serializeConversation(normalizeConversation(data as Conversation)));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
