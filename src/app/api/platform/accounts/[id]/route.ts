import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { WahaWhatsAppProvider } from "@/lib/whatsapp/providers/waha";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { getT } from "@/lib/i18n/translate";

/**
 * Disable or re-enable an account. Platform administrator only.
 *
 * Disabling keeps all data. It sets accounts.disabled_at (every request of
 * that account is then refused, inbound WhatsApp is dropped, API keys stop
 * working) and stops the account's WAHA session so no more messages arrive.
 * Re-enabling clears the flag; the person starts the session again from
 * Settings → WhatsApp.
 *
 * DELETE (below) is the permanent counterpart: it removes the account row
 * (all data cascades) and then deletes every member's login from
 * auth.users, so those emails can sign in again from scratch.
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

/**
 * Permanently delete an account and every user who signs in to it.
 * Platform administrator only.
 *
 * Order matters because of foreign keys:
 *   1. Collect the member user ids first — profiles.account_id cascades
 *      on account deletion, so after step 3 those rows are gone.
 *   2. Stop the WAHA session (best effort; the delete below is what
 *      guarantees the account is finished either way).
 *   3. Delete the accounts row: contacts, conversations, KB, configs,
 *      tags, invitations … all cascade from account_id.
 *   4. Delete each member's other owned accounts (guarded: only when
 *      every remaining member of that account is also being deleted, so
 *      we never wipe an unrelated workspace), then delete the login
 *      itself from auth.users — accounts.owner_user_id is ON DELETE
 *      RESTRICT, so owned accounts must go first.
 *
 * Failures are reported per user instead of silently swallowed; the
 * account row itself is already gone at that point.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requirePlatformAdmin();

    const limit = checkRateLimit(
      `platform:accountDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: t("platformAccounts.notFound") }, { status: 404 });
    }
    if (id === ctx.accountId) {
      return NextResponse.json({ error: t("platformAccounts.deleteOwnAccount") }, { status: 400 });
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
    if (target.can_create_workspaces === true) {
      return NextResponse.json({ error: t("platformAccounts.deletePlatform") }, { status: 400 });
    }

    // 1. Member logins to remove (owner included).
    const { data: memberRows, error: memberErr } = await admin
      .from("profiles")
      .select("user_id")
      .eq("account_id", id);
    if (memberErr) throw new Error(memberErr.message);
    const victimIds = [...new Set((memberRows ?? []).map((m) => m.user_id as string))];

    // 2. Best effort — stop inbound messages before the data vanishes.
    let sessionStopped = false;
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

    // 3. The account row — everything account-scoped cascades from here.
    const { error: delErr } = await admin.from("accounts").delete().eq("id", id);
    if (delErr) throw new Error(delErr.message);

    // 4. The logins. Each victim may own other accounts (a leftover
    //    personal workspace); those must go before auth.users, but only
    //    when nobody outside the deletion set is a member of them.
    const deletedUsers: string[] = [];
    const failed: { userId: string; error: string }[] = [];
    for (const userId of victimIds) {
      const { data: owned, error: ownedErr } = await admin
        .from("accounts")
        .select("id")
        .eq("owner_user_id", userId);
      if (ownedErr) {
        failed.push({ userId, error: ownedErr.message });
        continue;
      }

      let blocked: string | null = null;
      for (const acc of owned ?? []) {
        const { data: others, error: othersErr } = await admin
          .from("profiles")
          .select("user_id")
          .eq("account_id", acc.id);
        if (othersErr) {
          blocked = othersErr.message;
          break;
        }
        const outsiders = (others ?? []).filter((o) => !victimIds.includes(o.user_id as string));
        if (outsiders.length > 0) {
          blocked = `account ${acc.id} still has ${outsiders.length} member(s) outside this delete`;
          break;
        }
        const { error: accErr } = await admin.from("accounts").delete().eq("id", acc.id);
        if (accErr) {
          blocked = accErr.message;
          break;
        }
      }
      if (blocked) {
        failed.push({ userId, error: blocked });
        continue;
      }

      const { error: userErr } = await admin.auth.admin.deleteUser(userId);
      if (userErr) failed.push({ userId, error: userErr.message });
      else deletedUsers.push(userId);
    }

    return NextResponse.json({
      id,
      sessionStopped,
      deletedUsers: deletedUsers.length,
      failed,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
