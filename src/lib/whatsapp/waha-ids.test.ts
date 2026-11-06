import { describe, expect, it } from 'vitest'
import {
  ackToStatus,
  altPhoneFromPayload,
  digitsOf,
  isNonCustomerChat,
  isLidChatId,
  looksLikeLidNumber,
  phoneFromJid,
} from './waha-ids'

describe('lid detection', () => {
  it('recognises a lid chat id and a lid-length number', () => {
    expect(isLidChatId('30601675599946@lid')).toBe(true)
    expect(isLidChatId('628123456789@c.us')).toBe(false)
    expect(looksLikeLidNumber('30601675599946')).toBe(true)
    expect(looksLikeLidNumber('628123456789')).toBe(false)
    expect(looksLikeLidNumber('6281234567890')).toBe(false)
  })

  it('strips everything but digits', () => {
    expect(digitsOf('+62 812-3456@c.us')).toBe('628123456')
  })
})

describe('phoneFromJid', () => {
  it('reads c.us and s.whatsapp.net jids, including a device suffix', () => {
    expect(phoneFromJid('628123456789@c.us')).toBe('628123456789')
    expect(phoneFromJid('628123456789@s.whatsapp.net')).toBe('628123456789')
    expect(phoneFromJid('628123456789:12@s.whatsapp.net')).toBe('628123456789')
  })

  it('refuses a lid and anything else', () => {
    expect(phoneFromJid('30601675599946@lid')).toBeNull()
    expect(phoneFromJid('')).toBeNull()
    expect(phoneFromJid(null)).toBeNull()
  })
})

describe('altPhoneFromPayload', () => {
  it('finds the real number in the engine-specific fields', () => {
    expect(
      altPhoneFromPayload({ _data: { key: { remoteJidAlt: '628111@s.whatsapp.net' } } }),
    ).toBe('628111')
    expect(
      altPhoneFromPayload({ _data: { Info: { SenderAlt: '628222@s.whatsapp.net' } } }),
    ).toBe('628222')
  })

  it('returns null when none is present', () => {
    expect(altPhoneFromPayload({ from: 'x@lid' })).toBeNull()
    expect(altPhoneFromPayload(null)).toBeNull()
  })
})

describe('ackToStatus', () => {
  it('maps numeric acks', () => {
    expect(ackToStatus(-1)).toBe('failed')
    expect(ackToStatus(0)).toBeNull()
    expect(ackToStatus(1)).toBe('sent')
    expect(ackToStatus(2)).toBe('delivered')
    expect(ackToStatus(3)).toBe('read')
    expect(ackToStatus(4)).toBe('read')
  })

  it('falls back to the ack name', () => {
    expect(ackToStatus(undefined, 'device')).toBe('delivered')
    expect(ackToStatus(undefined, 'READ')).toBe('read')
    expect(ackToStatus(undefined, 'PENDING')).toBeNull()
  })
})

describe('isNonCustomerChat', () => {
  it('flags status updates, broadcast lists, channels and groups', () => {
    expect(isNonCustomerChat('status@broadcast')).toBe(true)
    expect(isNonCustomerChat('1234567890@broadcast')).toBe(true)
    expect(isNonCustomerChat('120363012345678901@newsletter')).toBe(true)
    expect(isNonCustomerChat('120363012345678901@g.us')).toBe(true)
  })

  it('keeps one-to-one chats, including hidden-number ids', () => {
    expect(isNonCustomerChat('628123456789@c.us')).toBe(false)
    expect(isNonCustomerChat('30601675599946@lid')).toBe(false)
    expect(isNonCustomerChat(undefined)).toBe(false)
  })
})
