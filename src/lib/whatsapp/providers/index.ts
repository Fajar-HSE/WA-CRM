import { decrypt } from '@/lib/whatsapp/encryption'
import { MetaWhatsAppProvider } from './meta'
import { WahaWhatsAppProvider } from './waha'
import type { WhatsAppConfig } from '@/types'
import type { WhatsAppProvider, WhatsAppProviderCredentials } from './provider'

export interface CreateProviderOptions {
  wahaBaseUrl?: string
  wahaApiKey?: string
}

export function createWhatsAppProvider(
  config: WhatsAppConfig,
  options: CreateProviderOptions = {},
): WhatsAppProvider {
  const provider = config.provider ?? 'meta'

  if (provider === 'waha') {
    const creds: WhatsAppProviderCredentials = {
      sessionName: config.waha_session_name || `wacrm-${config.id}`,
      baseUrl: config.waha_base_url || options.wahaBaseUrl || process.env.WAHA_BASE_URL,
      apiKey: options.wahaApiKey || process.env.WAHA_API_KEY,
    }
    return new WahaWhatsAppProvider(creds)
  }

  let accessToken = config.access_token
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    // keep as-is (e.g. tests pass plaintext)
  }

  return new MetaWhatsAppProvider({
    phoneNumberId: config.phone_number_id,
    accessToken,
  })
}
