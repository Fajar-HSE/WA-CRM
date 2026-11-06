import { describe, expect, it } from 'vitest'
import {
  isValidWahaSessionName,
  resolveWahaWebhookUrl,
  wahaPlaceholderPhoneId,
  wahaSecretMatches,
  wahaSessionNameForAccount,
  wahaStatusToConfigStatus,
} from './waha-config'

const ACCOUNT_A = '6f1c2b0e-4a3d-4f7e-9d2a-0b1c2d3e4f50'
const ACCOUNT_B = '11111111-2222-3333-4444-555555555555'

describe('wahaSessionNameForAccount', () => {
  it('derives a distinct, valid name per account', () => {
    const a = wahaSessionNameForAccount(ACCOUNT_A, undefined)
    const b = wahaSessionNameForAccount(ACCOUNT_B, undefined)
    expect(a).toBe('wa-crm-6f1c2b0e4a3d4f7e9d2a0b1c2d3e4f50')
    expect(a).not.toBe(b)
    expect(isValidWahaSessionName(a)).toBe(true)
  })

  it('pins every account to WAHA_SESSION_NAME when set', () => {
    expect(wahaSessionNameForAccount(ACCOUNT_A, ' default ')).toBe('default')
    expect(wahaSessionNameForAccount(ACCOUNT_B, 'default')).toBe('default')
  })

  it('rejects an invalid pinned name', () => {
    expect(() => wahaSessionNameForAccount(ACCOUNT_A, 'bad name!')).toThrow()
  })
})

describe('wahaSecretMatches', () => {
  it('accepts only an exact match', () => {
    expect(wahaSecretMatches('s3cret', 's3cret')).toBe(true)
    expect(wahaSecretMatches('s3cret', 's3creT')).toBe(false)
    expect(wahaSecretMatches('short', 'a-longer-secret')).toBe(false)
  })

  it('fails closed on missing values', () => {
    expect(wahaSecretMatches(null, 'x')).toBe(false)
    expect(wahaSecretMatches('x', undefined)).toBe(false)
    expect(wahaSecretMatches('', '')).toBe(false)
  })
})

describe('resolveWahaWebhookUrl', () => {
  it('prefers WAHA_WEBHOOK_URL, then the site URL, then the request origin', () => {
    const prevUrl = process.env.WAHA_WEBHOOK_URL
    const prevSite = process.env.NEXT_PUBLIC_SITE_URL
    try {
      process.env.WAHA_WEBHOOK_URL = 'http://app:3000/hook'
      expect(resolveWahaWebhookUrl('https://x.test')).toBe('http://app:3000/hook')
      delete process.env.WAHA_WEBHOOK_URL
      process.env.NEXT_PUBLIC_SITE_URL = 'https://crm.example.com/'
      expect(resolveWahaWebhookUrl('https://x.test')).toBe(
        'https://crm.example.com/api/whatsapp/waha/webhook',
      )
      delete process.env.NEXT_PUBLIC_SITE_URL
      expect(resolveWahaWebhookUrl('https://x.test/')).toBe(
        'https://x.test/api/whatsapp/waha/webhook',
      )
    } finally {
      if (prevUrl === undefined) delete process.env.WAHA_WEBHOOK_URL
      else process.env.WAHA_WEBHOOK_URL = prevUrl
      if (prevSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL
      else process.env.NEXT_PUBLIC_SITE_URL = prevSite
    }
  })
})

describe('misc', () => {
  it('builds a placeholder phone id and maps statuses', () => {
    expect(wahaPlaceholderPhoneId('default')).toBe('waha:default')
    expect(wahaStatusToConfigStatus('WORKING')).toBe('connected')
    expect(wahaStatusToConfigStatus('SCAN_QR_CODE')).toBe('disconnected')
  })
})
