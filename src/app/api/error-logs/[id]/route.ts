import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { isPlatformAccount } from '@/lib/logging/access';
import { getT } from '@/lib/i18n/translate';

const t = getT('ErrorLogs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Load the row only if the caller may touch it: it belongs to their
 * account, or it belongs to no account and the caller is the platform
 * account. Uses the service role, so this check is the whole gate.
 */
async function ownedRow(
  id: string,
  ctx: { supabase: Parameters<typeof isPlatformAccount>[0]; accountId: string },
): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('error_logs')
    .select('account_id')
    .eq('id', id)
    .maybeSingle();
  if (!data) return false;
  if (data.account_id === ctx.accountId) return true;
  return data.account_id === null && (await isPlatformAccount(ctx.supabase, ctx.accountId));
}

/** PATCH /api/error-logs/:id  { resolved: boolean }  (admin+) */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: t('notFound') }, { status: 404 });

    const body = (await request.json().catch(() => null)) as { resolved?: unknown } | null;
    if (!body || typeof body.resolved !== 'boolean') {
      return NextResponse.json({ error: t('invalidReport') }, { status: 400 });
    }
    if (!(await ownedRow(id, ctx))) {
      return NextResponse.json({ error: t('notFound') }, { status: 404 });
    }

    const { error } = await supabaseAdmin()
      .from('error_logs')
      .update(
        body.resolved
          ? { resolved_at: new Date().toISOString(), resolved_by: ctx.userId }
          : { resolved_at: null, resolved_by: null },
      )
      .eq('id', id);
    if (error) {
      console.error('[error-logs PATCH]', error);
      return NextResponse.json({ error: t('actionFailed') }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** DELETE /api/error-logs/:id  (admin+) */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: t('notFound') }, { status: 404 });
    if (!(await ownedRow(id, ctx))) {
      return NextResponse.json({ error: t('notFound') }, { status: 404 });
    }
    const { error } = await supabaseAdmin().from('error_logs').delete().eq('id', id);
    if (error) {
      console.error('[error-logs DELETE id]', error);
      return NextResponse.json({ error: t('actionFailed') }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
