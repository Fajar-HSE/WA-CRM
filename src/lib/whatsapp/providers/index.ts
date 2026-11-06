import { decrypt } from '@/lib/whatsapp/encryption'
import { MetaWhatsAppProvider } from './meta'
import { WahaWhatsAppProvider } from './waha'
import type { WhatsAppConfig } from '@/types'
import type { WhatsAppProvider, WhatsAppProviderCredentials } from './provider'

export interface CreateProviderOptions {
  wahaBaseUrl?: string
  wahaApiKey?: string
}

/**
 * Decrypted Meta access token for a config row, or '' for a WAHA row.
 *
 * WAHA rows carry no Meta token (the column is NOT NULL, so it holds an
 * empty string). Calling `decrypt('')` on one throws, which used to
 * break every outbound send for a WAHA account. Meta rows still
 * decrypt exactly as before and still throw on a corrupt ciphertext.
 */
export function resolveAccessToken(
  config: Pick<WhatsAppConfig, 'provider' | 'access_token'>,
): string {
  if ((config.provider ?? 'meta') === 'waha') return ''
  return decrypt(config.access_token)
}

export function createWhatsAppProvider(
  config: WhatsAppConfig,
  options: CreateProviderOptions = {},
): WhatsAppProvider {
  const provider = config.provider ?? 'meta'

  if (provider === 'waha') {
    const creds: WhatsAppProviderCredentials = {
      sessionName: config.waha_session_name || `wa-crm-${config.id.replace(/-/g, '')}`,
      // Server env only. `config.waha_base_url` is deliberately ignored: the
      // column is writable by account admins, and honouring it would send
      // WAHA_API_KEY to a host they control.
      baseUrl: options.wahaBaseUrl || process.env.WAHA_BASE_URL,
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
