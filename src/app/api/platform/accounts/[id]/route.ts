import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { WahaWhatsAppProvider } from "@/lib/whatsapp/providers/waha";
import { getT } from "@/lib/i18n/translate";

/**
 * Disable or re-enable an account. Platform administrator only.
 *
 * Disabling keeps all data. It sets accounts.disabled_at (every request of
 * that account is then refused, inbound WhatsApp is dropped, API keys stop
 * working) and stops the account's WAHA session so no more messages arrive.
 * Re-enabling clears the flag; the person starts the session again from
 * Settings → WhatsApp.
 */

const t = getT("Api");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requirePlatformAdmin();
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: t("platformAccounts.notFound") }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const disabled = (body as { disabled?: unknown } | null)?.disabled;
    if (typeof disabled !== "boolean") {
      return NextResponse.json({ error: t("platformAccounts.badRequest") }, { status: 400 });
    }

    if (id === ctx.accountId) {
      return NextResponse.json({ error: t("platformAccounts.ownAccount") }, { status: 400 });
    }

    const admin = supabaseAdmin();
    const { data: target, error: readErr } = await admin
      .from("accounts")
      .select("id, can_create_workspaces")
      .eq("id", id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!target) {
      return NextResponse.json({ error: t("platformAccounts.notFound") }, { status: 404 });
    }
    if (disabled && target.can_create_workspaces === true) {
      return NextResponse.json({ error: t("platformAccounts.isPlatform") }, { status: 400 });
    }

    const disabledAt = disabled ? new Date().toISOString() : null;
    const { error: updErr } = await admin
      .from("accounts")
      .update({ disabled_at: disabledAt })
      .eq("id", id);
    if (updErr) throw new Error(updErr.message);

    // Best effort: stop the WhatsApp session. The flag above is what really
    // blocks the account, so a WAHA hiccup must not fail the request.
    let sessionStopped = false;
    if (disabled) {
      try {
        const { data: cfg } = await admin
          .from("whatsapp_config")
          .select("provider, waha_session_name")
          .eq("account_id", id)
          .maybeSingle();
        const baseUrl = process.env.WAHA_BASE_URL?.trim();
        const apiKey = process.env.WAHA_API_KEY?.trim();
        if (cfg?.provider === "waha" && cfg.waha_session_name && baseUrl && apiKey) {
          const provider = new WahaWhatsAppProvider({
            sessionName: cfg.waha_session_name,
            baseUrl,
            apiKey,
          });
          await provider.stopSession(cfg.waha_session_name);
        sessionStopped = true;
        }
      } catch {
        sessionStopped = false;
      }
    }

    return NextResponse.json({ id, disabledAt, sessionStopped });
  } catch (err) {
    return toErrorResponse(err);
  }
}
