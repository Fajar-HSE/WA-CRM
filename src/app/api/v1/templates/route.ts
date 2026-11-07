// ============================================================
// GET  /api/v1/templates — list templates (scope: templates:read)
// POST /api/v1/templates — create a template (scope: templates:write)
// ============================================================

import { NextResponse } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';
import { TPL_LIST_SELECT, serializeTemplate, type TemplateRow } from '@/lib/api/v1/templates';
import { validateTemplatePayload, type TemplatePayload } from '@/lib/whatsapp/template-validators';
import { decrypt } from '@/lib/whatsapp/encryption';
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { ensureMediaHeaderHandle } from '@/lib/whatsapp/template-header-handle';
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize';
import { newLocalTemplateId, usesLocalTemplates } from '@/lib/whatsapp/local-template';

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  );
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:read');
    const { limit, cursor } = parseListParams(request);

    let query = ctx.supabase
      .from('message_templates')
      .select(TPL_LIST_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/templates] list error:', error);
      return fail('internal', 'Failed to list templates', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) => serializeTemplate(r as unknown as TemplateRow)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:write');

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const payload = body as unknown as TemplatePayload;
    try {
      validateTemplatePayload(payload);
    } catch (e) {
      return fail('bad_request', e instanceof Error ? e.message : 'Invalid template', 400);
    }

    // Find existing (idempotent re-submit of an unsubmitted DRAFT).
    const { data: existing, error: existingErr } = await ctx.supabase
      .from('message_templates')
      .select('id, status, meta_template_id')
      .eq('account_id', ctx.accountId)
      .eq('name', payload.name)
      .eq('language', payload.language)
      .maybeSingle();
    if (existingErr) {
      return fail('internal', 'Failed to save template', 500);
    }
    const isUnsubmittedDraft =
      !!existing && existing.meta_template_id === null && (existing.status ?? 'DRAFT') === 'DRAFT';
    if (existing && !isUnsubmittedDraft) {
      return fail(
        'bad_request',
        `A template named "${payload.name}" (${payload.language}) already exists`,
        409
      );
    }
    const existingDraftId = existing?.id ?? null;

    const { data: providerRow } = await ctx.supabase
      .from('whatsapp_config')
      .select('provider')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    const isLocal = usesLocalTemplates(providerRow as { provider?: string | null } | null);

    let metaTemplateId: string;
    let metaStatus: string;

    if (isLocal) {
      metaTemplateId = newLocalTemplateId();
      metaStatus = 'APPROVED';
    } else if (isDryRun()) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`;
      metaStatus = 'PENDING';
    } else {
      const { data: config, error: configError } = await ctx.supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', ctx.accountId)
        .single();
      if (configError || !config) {
        return fail('bad_request', 'WhatsApp is not configured for this account', 400);
      }
      if (!config.waba_id) {
        return fail('bad_request', 'WABA ID is missing', 400);
      }
      const accessToken = decrypt(config.access_token);
      try {
        await ensureMediaHeaderHandle(payload, accessToken);
      } catch (e) {
        return fail('bad_request', e instanceof Error ? e.message : 'Header upload failed', 400);
      }
      const metaPayload = buildMetaTemplatePayload(payload);
      try {
        const meta = await submitMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          payload: metaPayload,
        });
        metaTemplateId = meta.id;
        metaStatus = meta.status;
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta submit failed';
        // Persist failure as DRAFT so caller can retry.
        const row = {
          account_id: ctx.accountId,
          name: payload.name,
          category: payload.category,
          language: payload.language,
          header_type: payload.header_type ?? null,
          header_content: payload.header_content ?? null,
          header_media_url: payload.header_media_url ?? null,
          header_handle: payload.header_handle ?? null,
          body_text: payload.body_text,
          footer_text: payload.footer_text ?? null,
          buttons: payload.buttons ?? null,
          sample_values: payload.sample_values ?? null,
          status: 'DRAFT',
          meta_template_id: null,
          submission_error: message,
          rejection_reason: null,
          last_submitted_at: new Date().toISOString(),
        };
        if (existingDraftId) {
          await ctx.supabase.from('message_templates').update(row).eq('id', existingDraftId).eq('account_id', ctx.accountId);
        } else {
          await ctx.supabase.from('message_templates').insert({ ...row, user_id: ctx.createdBy });
        }
        return fail('internal', message, 502);
      }
    }

    const row = {
      account_id: ctx.accountId,
      name: payload.name,
      category: payload.category,
      language: payload.language,
      header_type: payload.header_type ?? null,
      header_content: payload.header_content ?? null,
      header_media_url: payload.header_media_url ?? null,
      header_handle: payload.header_handle ?? null,
      body_text: payload.body_text,
      footer_text: payload.footer_text ?? null,
      buttons: payload.buttons ?? null,
      sample_values: payload.sample_values ?? null,
      status: normalizeStatus(metaStatus),
      meta_template_id: metaTemplateId,
      submission_error: null,
      rejection_reason: null,
      last_submitted_at: new Date().toISOString(),
    };

    let saved: TemplateRow | null = null;
    if (existingDraftId) {
      const { data, error } = await ctx.supabase
        .from('message_templates')
        .update(row)
        .eq('id', existingDraftId)
        .eq('account_id', ctx.accountId)
        .select(TPL_LIST_SELECT)
        .single();
      if (error || !data) {
        return fail('internal', 'Failed to save template', 500);
      }
      saved = data as unknown as TemplateRow;
    } else {
      const { data, error } = await ctx.supabase
        .from('message_templates')
        .insert({ ...row, user_id: ctx.createdBy })
        .select(TPL_LIST_SELECT)
        .single();
      if (error || !data) {
        console.error('[api/v1/templates] insert error:', error);
        return fail('internal', 'Failed to save template', 500);
      }
      saved = data as unknown as TemplateRow;
    }

    return ok({ ...serializeTemplate(saved!), created: !existingDraftId, local: isLocal }, existingDraftId ? 200 : 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}