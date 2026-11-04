// ============================================================
// Platform admin: the list of every account, one row per account.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PlatformAccountRow {
  id: string;
  name: string;
  ownerEmail: string | null;
  ownerName: string | null;
  memberCount: number;
  createdAt: string;
  disabledAt: string | null;
  whatsappStatus: string | null;
  /** True for accounts that hold the platform flag (cannot be disabled). */
  isPlatform: boolean;
}

interface AccountDbRow {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  disabled_at: string | null;
  can_create_workspaces: boolean | null;
}

interface ProfileDbRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
  account_id: string | null;
}

interface ConfigDbRow {
  account_id: string;
  status: string | null;
  waha_session_status: string | null;
}

/**
 * Build the list with the service-role client (the caller has already been
 * checked by requirePlatformAdmin). Newest account first.
 */
export async function listPlatformAccounts(
  admin: SupabaseClient,
): Promise<PlatformAccountRow[]> {
  const [accountsRes, profilesRes, configsRes] = await Promise.all([
    admin
      .from("accounts")
      .select("id, name, owner_user_id, created_at, disabled_at, can_create_workspaces")
      .order("created_at", { ascending: false }),
    admin.from("profiles").select("user_id, email, full_name, account_id"),
    admin.from("whatsapp_config").select("account_id, status, waha_session_status"),
  ]);
  if (accountsRes.error) throw new Error(accountsRes.error.message);
  if (profilesRes.error) throw new Error(profilesRes.error.message);
  // A missing whatsapp_config is fine: the account simply has no number yet.

  const profiles = (profilesRes.data ?? []) as ProfileDbRow[];
  const byUser = new Map(profiles.map((p) => [p.user_id, p]));
  const members = new Map<string, number>();
  for (const p of profiles) {
    if (p.account_id) members.set(p.account_id, (members.get(p.account_id) ?? 0) + 1);
  }
  const configs = new Map(
    ((configsRes.data ?? []) as ConfigDbRow[]).map((c) => [c.account_id, c]),
  );

  return ((accountsRes.data ?? []) as AccountDbRow[]).map((a) => {
    const owner = byUser.get(a.owner_user_id);
    const cfg = configs.get(a.id);
    return {
      id: a.id,
      name: a.name,
      ownerEmail: owner?.email ?? null,
      ownerName: owner?.full_name ?? null,
      memberCount: members.get(a.id) ?? 0,
      createdAt: a.created_at,
      disabledAt: a.disabled_at,
      whatsappStatus: cfg?.waha_session_status ?? cfg?.status ?? null,
      isPlatform: a.can_create_workspaces === true,
    };
  });
}
