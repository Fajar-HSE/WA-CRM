import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { logError } from '@/lib/logging/error-log';
import { cleanMessage, scrubText } from '@/lib/logging/sanitize';
import { isPlatformAccount } from '@/lib/logging/access';
import { getT } from '@/lib/i18n/translate';

const t = getT('ErrorLogs');

const COLUMNS =
  'id, account_id, source, level, message, stack, context, occurrences, first_seen_at, last_seen_at, resolved_at';
const PAGE_SIZE = 100;

/**
 * GET /api/error-logs?status=open|resolved|all   (admin+)
 * The account's problems, newest first. The platform account also sees
 * problems that belong to no account (server errors outside a session).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const status = new URL(request.url).searchParams.get('status') ?? 'open';

    const platform = await isPlatformAccount(supabase, accountId);
    // Row-level security already limits an admin to their account; the
    // platform account reads through the service role to include the
    // account-less rows too.
    const db = platform ? supabaseAdmin() : supabase;
    let query = db.from('error_logs').select(COLUMNS);
    query = platform
      ? query.or(`account_id.eq.${accountId},account_id.is.null`)
      : query.eq('account_id', accountId);
    if (status === 'open') query = query.is('resolved_at', null);
    else if (status === 'resolved') query = query.not('resolved_at', 'is', null);

    const { data, error } = await query
      .order('last_seen_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (error) {
      console.error('[error-logs GET]', error);
      return NextResponse.json({ error: t('loadFailed') }, { status: 500 });
    }
    return NextResponse.json({ logs: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/error-logs — a signed-in browser reports a crash.
 * Any role may report; the text is cleaned again here because the browser
 * is not trusted.
 */
export async function POST(request: Request) {
  try {
    const { userId, accountId } = await getCurrentAccount();
    const limit = checkRateLimit(`error-report:${userId}`, RATE_LIMITS.clientErrorReport);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return NextResponse.json({ error: t('invalidReport') }, { status: 400 });
    }

    const err = new Error(body.message.slice(0, 1000));
    err.stack =
      typeof body.stack === 'string' ? scrubText(body.stack.slice(0, 6000)) : undefined;

    // Only the path of the page, never its query string.
    let path = '';
    if (typeof body.url === 'string') {
      try {
        path = new URL(body.url, 'http://x').pathname.slice(0, 200);
      } catch {
        path = '';
      }
    }
    const kind = typeof body.kind === 'string' ? body.kind.slice(0, 40) : 'error';
    const digest = typeof body.digest === 'string' ? body.digest.slice(0, 80) : undefined;

    await logError('ui', err, {
      accountId,
      context: { path, kind, digest, message: cleanMessage(err) },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** DELETE /api/error-logs?resolved=1 — remove every solved problem (admin+). */
export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    if (new URL(request.url).searchParams.get('resolved') !== '1') {
      return NextResponse.json({ error: t('invalidReport') }, { status: 400 });
    }
    const { error } = await supabase
      .from('error_logs')
      .delete()
      .eq('account_id', accountId)
      .not('resolved_at', 'is', null);
    if (error) {
      console.error('[error-logs DELETE]', error);
      return NextResponse.json({ error: t('actionFailed') }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
