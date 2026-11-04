// ============================================================
// Platform administrator guard.
//
// The platform administrator is the account that holds
// accounts.can_create_workspaces: the one that hands out new accounts
// (see migration 063). Only its owner may see the list of all accounts or
// switch one off.
// ============================================================

import { ForbiddenError, requireRole, type AccountContext } from "@/lib/auth/account";
import { getT } from "@/lib/i18n/translate";

const t = getT("LibErrors.auth");

export async function requirePlatformAdmin(): Promise<AccountContext> {
  const ctx = await requireRole("owner");
  const { data, error } = await ctx.supabase
    .from("accounts")
    .select("can_create_workspaces")
    .eq("id", ctx.accountId)
    .maybeSingle();
  // An unreadable flag (migration 063 missing) is "no": fail closed.
  if (error || data?.can_create_workspaces !== true) {
    throw new ForbiddenError(t("platformOnly"));
  }
  return ctx;
}
