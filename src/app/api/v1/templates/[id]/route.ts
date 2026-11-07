// ============================================================
// GET    /api/v1/templates/{id} — read one (scope: templates:read)
// PATCH  /api/v1/templates/{id} — edit (scope: templates:write)
// DELETE /api/v1/templates/{id} — delete (scope: templates:write)
// ============================================================

import { NextResponse } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { TPL_LIST_SELECT, serializeTemplate, type TemplateRow } from '@/lib/api/v1/templates';
import { validateTemplatePayload, type TemplatePayload } from '@/lib/whatsapp/template-validators';
import { decrypt } from '@/lib/whatsapp/encryption';
import { editMessageTemplate, deleteMessageTemplate } from '@/lib/whatsapp/meta-api';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { ensureMediaHeaderHandle } from '@/lib/whatsapp/template-header-handle';
import { canEditTemplateCategory } from '@/lib/whatsapp/template-category-edit';
import { isLocalTemplateId } from '@/lib/whatsapp/local-template';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'templates:read');
    const { id } = await context.params;
    if (!UUID_RE.test(id)) return fail('bad_request', 'Invalid id', 400);

    const { data, error } = await ctx.supabase
      .from('message_templates')
      .select(TPL_LIST_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error || !data) return fail('not_found', 'Template not found', 404);
    return ok(serializeTemplate(data as unknown as TemplateRow));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'templates:write');
    const { id } = await context.params;
    if (!UUID_RE.test(id)) return fail('bad_request', 'Invalid id', 400);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    const payload = body as unknown as TemplatePayload;

    const { data: existing, error: lookupErr } = await ctx.supabase
      .from('message_templates')
      .select('id, name, status, category, meta_template_id, language')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (lookupErr || !existing) return fail('not_found', 'Template not found', 404);

    // Local template (WAHA): no Meta round trip.
    if (isLocalTemplateId(existing.meta_template_id)) {
      try {
        validateTemplatePayload({ ...payload, name: existing.name, language: existing.language });
      } catch (e) {
        return fail('bad_request', e instanceof Error ? e.message : 'Invalid template', 400);
      }
      const { data: row, error: updErr } = await ctx.supabase
        .from('message_templates')
        .update({
          body_text: payload.body_text,
          footer_text: payload.footer_text ?? null,
          sample_values: payload.sample_values ?? null,
          status: 'APPROVED',
          submission_error: null,
          rejection_reason: null,
        })
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .select(TPL_LIST_SELECT)
        .single();
      if (updErr || !row) return fail('internal', 'Failed to edit template', 500);
      return ok({ ...serializeTemplate(row as unknown as TemplateRow), local: true });
    }

    if (!existing.meta_template_id) {
      return fail('bad_request', 'Template was never submitted', 400);
    }
    const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED']);
    if (!EDITABLE_STATUSES.has(existing.status)) {
      return fail('bad_request', `Template status ${existing.status} is not editable`, 400);
    }

    if (payload.category === 'Authentication') {
      return fail('bad_request', 'Authentication templates are not editable', 400);
    }
    try {
      validateTemplatePayload(payload);
    } catch (e) {
      return fail('bad_request', e instanceof Error ? e.message : 'Invalid template', 400);
    }

    const categoryChanged = payload.category !== existing.category;
    if (categoryChanged) {
      // canEditTemplateCategory
      const { canEditTemplateCategory } = await import('@/lib/whatsapp/template-category-edit');
      if (!canEditTemplateCategory(existing.status)) {
        return fail('bad_request', 'Category cannot be changed for an approved template', 400);
      }
    }

    if (!isDryRun()) {
      const { data: config, error: configError } = await ctx.supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', ctx.accountId)
        .single();
      if (configError || !config) {
        return fail('bad_request', 'WhatsApp is not configured for this account', 400);
      }
      const accessToken = decrypt(config.access_token);
      try {
        await ensureMediaHeaderHandle(payload, accessToken);
      } catch (e) {
        return fail('bad_request', e instanceof Error ? e.message : 'Header upload failed', 400);
      }
      const metaPayload = buildMetaTemplatePayload(payload);
      try {
        await editMessageTemplate({
          metaTemplateId: existing.meta_template_id,
          accessToken,
          components: metaPayload.components,
          category: categoryChanged ? metaPayload.category : undefined,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta edit failed';
        await ctx.supabase
          .from('message_templates')
          .update({ submission_error: message, last_submitted_at: new Date().toISOString() })
          .eq('id', id)
          .eq('account_id', ctx.accountId);
        return fail('internal', message, 502);
      }
    }

    const { data: row, error: updErr } = await ctx.supabase
      .from('message_templates')
      .update({
        category: payload.category,
        header_type: payload.header_type ?? null,
        header_content: payload.header_content ?? null,
        header_media_url: payload.header_media_url ?? null,
        header_handle: payload.header_handle ?? null,
        body_text: payload.body_text,
        footer_text: payload.footer_text ?? null,
        buttons: payload.buttons ?? null,
        sample_values: payload.sample_values ?? null,
        status: 'PENDING',
        submission_error: null,
        rejection_reason: null,
        last_submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(TPL_LIST_SELECT)
      .single();
    if (updErr || !row) return fail('internal', 'Failed to edit template', 500);
    return ok({ ...serializeTemplate(row as unknown as TemplateRow), dry_run: isDryRun() });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'templates:write');
    const { id } = await context.params;
    if (!UUID_RE.test(id)) return fail('bad_request', 'Invalid id', 400);

    const { data: existing, error: lookupErr } = await ctx.supabase
      .from('message_templates')
      .select('id, name, meta_template_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (lookupErr || !existing) return fail('not_found', 'Template not found', 404);

    if (existing.meta_template_id && !isLocalTemplateId(existing.meta_template_id) && !isDryRun()) {
      const { data: config, error: configError } = await ctx.supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', ctx.accountId)
        .single();
      if (configError || !config || !config.waba_id) {
        return fail('bad_request', 'WhatsApp is not configured for this account', 400);
      }
      const accessToken = decrypt(config.access_token);
      try {
        await deleteMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.meta_template_id,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta delete failed';
        return fail('internal', message, 502);
      }
    }

    const { error: delErr } = await ctx.supabase
      .from('message_templates')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId);
    if (delErr) return fail('internal', 'Failed to delete template', 500);
    return ok({ success: true, dry_run: isDryRun() });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}