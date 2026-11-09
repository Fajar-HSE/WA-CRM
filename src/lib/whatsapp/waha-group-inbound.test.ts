import { beforeEach, describe, expect, it, vi } from 'vitest'

const GROUP = '120363012345678901@g.us'

const state = {
  group: { id: 'g-1', subject: 'Peserta K3', monitored: true } as Record<string, unknown> | null,
  config: { account_id: 'acct-1', id: 'cfg-1', provider: 'waha' } as Record<string, unknown> | null,
  disabled: null as string | null,
  upsertEmpty: false,
  upserts: [] as Record<string, unknown>[],
  groupUpdates: [] as Record<string, unknown>[],
  inserts: 0,
}

function makeDb() {
  return {
    from: (table: string) => {
      const ctx: { op?: string; values?: Record<string, unknown> } = {}
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === 'whatsapp_config') return { data: state.config, error: null }
          if (table === 'whatsapp_groups') return { data: state.group, error: null }
          if (table === 'accounts') return { data: { disabled_at: state.disabled }, error: null }
          return { data: null, error: null }
        },
        upsert: (row: Record<string, unknown>) => {
          ctx.op = 'upsert'
          state.upserts.push(row)
          return chain
        },
        update: (values: Record<string, unknown>) => {
          ctx.op = 'update'
          ctx.values = values
          return chain
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (ctx.op === 'update' && table === 'whatsapp_groups') state.groupUpdates.push(ctx.values!)
          if (ctx.op === 'upsert' && state.upsertEmpty) return resolve({ data: [], error: null })
          return resolve({ data: [{ id: 'm-1' }], error: null })
        },
      }
      return chain
    },
  }
}
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => makeDb() }))

const getGroup = vi.fn()
vi.mock('@/lib/whatsapp/providers/waha', () => {
  class WahaWhatsAppProvider {
    getGroup(...a: unknown[]) {
      return getGroup(...a)
    }
  }
  return { WahaWhatsAppProvider }
})
vi.mock('@/lib/whatsapp/providers', async () => {
  const { WahaWhatsAppProvider } = await import('@/lib/whatsapp/providers/waha')
  const Ctor = WahaWhatsAppProvider as unknown as new () => object
  return { createWhatsAppProvider: () => new Ctor() }
})

import { processWahaGroupMessage } from './waha-group-inbound'

const incoming = {
  id: 'false_120363@g.us_AAA_628111@c.us',
  from: GROUP,
  participant: '6281111111111@c.us',
  body: 'Jadwal ujian kapan?',
  timestamp: 1_700_000_000,
  _data: { pushName: 'Budi' },
}

describe('processWahaGroupMessage', () => {
  beforeEach(() => {
    state.group = { id: 'g-1', subject: 'Peserta K3', monitored: true }
    state.config = { account_id: 'acct-1', id: 'cfg-1', provider: 'waha' }
    state.disabled = null
    state.upsertEmpty = false
    state.upserts = []
    state.groupUpdates = []
    getGroup.mockReset()
  })

  it('saves a message of a monitored group with its sender', async () => {
    await processWahaGroupMessage({ sessionName: 's', payload: incoming })
    expect(state.upserts).toHaveLength(1)
    expect(state.upserts[0]).toMatchObject({
      group_id: 'g-1',
      account_id: 'acct-1',
      message_id: incoming.id,
      from_me: false,
      sender_phone: '6281111111111',
      sender_name: 'Budi',
      content_text: 'Jadwal ujian kapan?',
      created_at: new Date(1_700_000_000 * 1000).toISOString(),
    })
    expect(state.groupUpdates[0]).toMatchObject({ last_message_text: 'Jadwal ujian kapan?' })
  })

  it('drops a group nobody chose to monitor, writing nothing', async () => {
    state.group = null
    await processWahaGroupMessage({ sessionName: 's', payload: incoming })
    expect(state.upserts).toEqual([])
  })

  it('drops a group whose monitoring was turned off', async () => {
    state.group = { id: 'g-1', subject: 'X', monitored: false }
    await processWahaGroupMessage({ sessionName: 's', payload: incoming })
    expect(state.upserts).toEqual([])
  })

  it('does nothing for a non-group chat, a missing id, or an unknown session', async () => {
    await processWahaGroupMessage({ sessionName: 's', payload: { ...incoming, from: '628@c.us' } })
    await processWahaGroupMessage({ sessionName: 's', payload: { ...incoming, id: null } })
    state.config = null
    await processWahaGroupMessage({ sessionName: 's', payload: incoming })
    expect(state.upserts).toEqual([])
  })

  it('does nothing for a disabled account', async () => {
    state.disabled = '2026-01-01'
    await processWahaGroupMessage({ sessionName: 's', payload: incoming })
    expect(state.upserts).toEqual([])
  })

  it('records our own message in a group (to = group, fromMe)', async () => {
    await processWahaGroupMessage({
      sessionName: 's',
      payload: { id: 'true_x', fromMe: true, to: GROUP, body: 'Siap', timestamp: 5 },
    })
    expect(state.upserts[0]).toMatchObject({ from_me: true, sender_phone: null, sender_name: null })
  })

  it('keeps an unreadable sender without a number', async () => {
    await processWahaGroupMessage({
      sessionName: 's',
      payload: { ...incoming, participant: '30601675599946@lid' },
    })
    expect(state.upserts[0]).toMatchObject({ sender_phone: null, sender_name: 'Budi' })
  })

  it('uses the real number WhatsApp sends next to a hidden id', async () => {
    await processWahaGroupMessage({
      sessionName: 's',
      payload: {
        ...incoming,
        participant: '30601675599946@lid',
        _data: { pushName: 'Budi', key: { participantAlt: '6283333333333@s.whatsapp.net' } },
      },
    })
    expect(state.upserts[0]).toMatchObject({ sender_phone: '6283333333333' })
  })

  it('stores a marker for a media message without text', async () => {
    await processWahaGroupMessage({
      sessionName: 's',
      payload: { ...incoming, body: '', hasMedia: true },
    })
    expect(state.upserts[0]).toMatchObject({ content_type: 'media' })
    expect(String(state.upserts[0].content_text)).toMatch(/^\[(Lampiran|Attachment)\]$/)
  })

  it('skips a message with neither text nor media', async () => {
    await processWahaGroupMessage({ sessionName: 's', payload: { ...incoming, body: '' } })
    expect(state.upserts).toEqual([])
  })

  it('leaves the group alone when the message was already saved', async () => {
    state.upsertEmpty = true
    await processWahaGroupMessage({ sessionName: 's', payload: incoming })
    expect(state.groupUpdates).toEqual([])
  })

  it('learns the group name once when it was saved without one', async () => {
    state.group = { id: 'g-1', subject: null, monitored: true }
    getGroup.mockResolvedValue({ id: GROUP, subject: 'Alumni ICC', size: 10 })
    await processWahaGroupMessage({ sessionName: 's', payload: incoming })
    expect(getGroup).toHaveBeenCalledWith(GROUP)
    expect(state.groupUpdates.some((u) => u.subject === 'Alumni ICC')).toBe(true)
  })
})
