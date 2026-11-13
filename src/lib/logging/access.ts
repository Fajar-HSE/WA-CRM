import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * True when this account is the platform account (the one that may also
 * see errors that belong to no account). Fails closed.
 */
export async function isPlatformAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('accounts')
    .select('can_create_workspaces')
    .eq('id', accountId)
    .maybeSingle();
  return !error && data?.can_create_workspaces === true;
}
