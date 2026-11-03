import { beforeEach, describe, expect, it, vi } from 'vitest'

const LID = '30601675599946'
const REAL = '628123456789'

// ---- fake database ---------------------------------------------------
const contactUpdates: { values: Record<string, unknown>; id: string }[] = []
const contactInserts: Record<string, unknown>[] = []

function makeDb() {
  const from = (table: string) => {
    const state: { op?: string; values?: Record<string, unknown>; id?: string } = {}
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: string) => {
        if (col === 'id') state.id = val
        return chain
      },
      order: () => chain,
      limit: async () =>
        table === 'conversations'
          ? { data: [{ id: 'conv-1', status: 'open' }], error: null }
          : { data: [], error: null },
      maybeSingle: async () => ({
        data: table === 'whatsapp_config' ? { account_id: 'acct-1', user_id: 'user-1', id: 'cfg-1', provider: 'waha' } : null,
        error: null,
      }),
      single: async () => ({ data: { id: 'new-contact' }, error: null }),
      insert: (values: Record<string, unknown>) => {
        if (table === 'contacts') contactInserts.push(values)
        return chain
      },
      update: (values: Record<string, unknown>) => {
        state.op = 'update'
        state.values = values
        return chain
      },
      upsert: () => chain,
      then: (resolve: (v: unknown) => unknown) => {
        if (state.op === 'update' && table === 'contacts') {
          contactUpdates.push({ values: state.values!, id: state.id! })
        }
        return resolve({ data: [{ id: 'msg-1' }], error: null })
      },
    }
    return chain
  }
  return { from, rpc: async () => ({ data: null, error: null }) }
}

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => makeDb() }))

const findExistingContact = vi.fn()
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: (...a: unknown[]) => findExistingContact(...a),
}))
vi.mock('@/lib/conversations/first-inbound', () => ({ claimFirstInboundMessage: async () => false }))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation: async () => false }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: async () => ({ consumed: false }) }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: async () => undefined }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: async () => undefined }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: async () => undefined }))

const getPhoneForLid = vi.fn()
vi.mock('@/lib/whatsapp/providers/waha', () => {
  class WahaWhatsAppProvider {
    getPhoneForLid(...a: unknown[]) {
      return getPhoneForLid(...a)
    }
  }
  return { WahaWhatsAppProvider }
})
vi.mock('@/lib/whatsapp/providers', async () => {
  const { WahaWhatsAppProvider } = await import('@/lib/whatsapp/providers/waha')
  const Ctor = WahaWhatsAppProvider as unknown as new () => object
  return { createWhatsAppProvider: () => new Ctor() }
})

import { processWahaInbound } from './waha-inbound'

function byPhone(map: Record<string, unknown>) {
  findExistingContact.mockImplementation(async (_db, _acct, phone: string) => map[phone] ?? null)
}

describe('processWahaInbound with a lid sender', () => {
  beforeEach(() => {
    contactUpdates.length = 0
    contactInserts.length = 0
    findExistingContact.mockReset()
    getPhoneForLid.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('corrects a legacy contact that stored the lid as its phone', async () => {
    getPhoneForLid.mockResolvedValue(REAL)
    byPhone({ [LID]: { id: 'legacy-1', phone: LID } })

    await processWahaInbound({
      sessionName: 's',
      payload: { id: 'm1', from: `${LID}@lid`, body: 'halo', timestamp: 1 },
    })

    expect(contactUpdates).toEqual([{ id: 'legacy-1', values: { phone: REAL } }])
    expect(contactInserts).toEqual([])
  })

  it('uses the real number from the payload without calling WAHA', async () => {
    byPhone({})
    await processWahaInbound({
      sessionName: 's',
      payload: {
        id: 'm1',
        from: `${LID}@lid`,
        body: 'halo',
        timestamp: 1,
        _data: { key: { remoteJidAlt: `${REAL}@s.whatsapp.net` } },
      },
    })
    expect(getPhoneForLid).not.toHaveBeenCalled()
    expect(contactInserts[0]).toMatchObject({ phone: REAL })
  })

  it('keeps the lid as a fallback key when the real number cannot be found', async () => {
    getPhoneForLid.mockResolvedValue(null)
    byPhone({})
    await processWahaInbound({
      sessionName: 's',
      payload: { id: 'm1', from: `${LID}@lid`, body: 'halo', timestamp: 1 },
    })
    expect(contactInserts[0]).toMatchObject({ phone: LID })
  })

  it('does not touch the lookup for an ordinary phone sender', async () => {
    byPhone({})
    await processWahaInbound({
      sessionName: 's',
      payload: { id: 'm1', from: `${REAL}@c.us`, body: 'halo', timestamp: 1 },
    })
    expect(getPhoneForLid).not.toHaveBeenCalled()
    expect(contactInserts[0]).toMatchObject({ phone: REAL })
  })
})
