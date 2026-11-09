import type { SupabaseClient } from '@supabase/supabase-js'

import { createWhatsAppProvider } from '@/lib/whatsapp/providers'
import { WahaWhatsAppProvider } from '@/lib/whatsapp/providers/waha'
import type { WhatsAppConfig } from '@/types'

/**
 * The WAHA provider for an account's own WhatsApp connection, or null when
 * the account has none or is not on WAHA. The caller's client is used for the
 * lookup, so row-level security decides which row it can see.
 */
export async function loadWahaProvider(
  db: SupabaseClient,
  accountId: string,
): Promise<WahaWhatsAppProvider | null> {
  const { data: config } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!config) return null
  try {
    const provider = createWhatsAppProvider(config as WhatsAppConfig)
    return provider instanceof WahaWhatsAppProvider ? provider : null
  } catch {
    return null
  }
}
