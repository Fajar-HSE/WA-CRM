import { beforeEach, describe, expect, it, vi } from 'vitest'

const LID = '30601675599946'
const REAL = '628123456789'

// ---- fake database ---------------------------------------------------
const contactUpdates: { values: Record<string, unknown>; id: string }[] = []
const contactInserts: Record<string, unknown>[] = []
const messageUpserts: Record<string, unknown>[] = []
const webhookEvents: Record<string, unknown>[] = []
const conversationUpdates: Record<string, unknown>[] = []
let upsertEmpty = false

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
      upsert: (values: Record<string, unknown>) => {
        state.op = 'upsert'
        if (table === 'messages') messageUpserts.push(values)
        return chain
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (state.op === 'update' && table === 'contacts') {
          contactUpdates.push({ values: state.values!, id: state.id! })
        }
        if (state.op === 'update' && table === 'conversations') {
          conversationUpdates.push(state.values!)
        }
        if (state.op === 'upsert' && upsertEmpty) return resolve({ data: [], error: null })
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
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: async (_db: unknown, _acct: string, _event: string, data: Record<string, unknown>) => {
    webhookEvents.push(data)
  },
}))

const mirrorWahaMedia = vi.fn()
vi.mock('./waha-media', () => ({ mirrorWahaMedia: (...a: unknown[]) => mirrorWahaMedia(...a) }))

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

import { processWahaInbound, processWahaOutgoing } from './waha-inbound'

function byPhone(map: Record<string, unknown>) {
  findExistingContact.mockImplementation(async (_db, _acct, phone: string) => map[phone] ?? null)
}

describe('processWahaInbound with a lid sender', () => {
  beforeEach(() => {
    contactUpdates.length = 0
    contactInserts.length = 0
    messageUpserts.length = 0
    webhookEvents.length = 0
    mirrorWahaMedia.mockReset()
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

  describe('inbound media', () => {
    const imagePayload = {
      id: 'false_628@c.us_IMG1',
      from: `${REAL}@c.us`,
      body: 'foto ktp',
      timestamp: 1,
      hasMedia: true,
      media: { url: 'http://localhost:3000/api/files/s/x.jpeg', mimetype: 'image/jpeg' },
    }

    it('stores the mirrored public url, not WAHA\'s private one', async () => {
      byPhone({})
      mirrorWahaMedia.mockResolvedValue('https://cdn.test/chat-media/photo.jpg')
      await processWahaInbound({ sessionName: 's', payload: imagePayload })

      expect(mirrorWahaMedia).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acct-1', messageId: 'false_628@c.us_IMG1', media: imagePayload.media }),
      )
      expect(messageUpserts[0]).toMatchObject({
        content_type: 'image',
        media_url: 'https://cdn.test/chat-media/photo.jpg',
        media_type: 'image/jpeg',
        content_text: 'foto ktp',
      })
      expect(webhookEvents[0]).toMatchObject({ content_type: 'image' })
    })

    it('still delivers the message, without a file, when the mirror fails', async () => {
      byPhone({})
      mirrorWahaMedia.mockResolvedValue(null)
      await processWahaInbound({ sessionName: 's', payload: imagePayload })
      expect(messageUpserts[0]).toMatchObject({ content_type: 'image', media_url: null })
    })

    it('does not touch media for a plain text message', async () => {
      byPhone({})
      await processWahaInbound({
        sessionName: 's',
        payload: { id: 'm1', from: `${REAL}@c.us`, body: 'halo', timestamp: 1 },
      })
      expect(mirrorWahaMedia).not.toHaveBeenCalled()
      expect(messageUpserts[0]).toMatchObject({ content_type: 'text', media_url: null })
    })

    it('labels non-image media by its real kind', async () => {
      byPhone({})
      mirrorWahaMedia.mockResolvedValue('https://cdn.test/a.ogg')
      await processWahaInbound({
        sessionName: 's',
        payload: {
          id: 'm2',
          from: `${REAL}@c.us`,
          timestamp: 1,
          hasMedia: true,
          media: { url: 'http://x/api/files/a.ogg', mimetype: 'audio/ogg; codecs=opus' },
        },
      })
      expect(messageUpserts[0]).toMatchObject({ content_type: 'audio' })
    })
  })

  describe('contact name', () => {
    it('uses the NOWEB push name for a new contact', async () => {
      byPhone({})
      await processWahaInbound({
        sessionName: 's',
        payload: {
          id: 'm1',
          from: `${REAL}@c.us`,
          body: 'halo',
          timestamp: 1,
          _data: { pushName: 'Budi Santoso' },
        },
      })
      expect(contactInserts[0]).toMatchObject({ phone: REAL, name: 'Budi Santoso' })
    })

    it('falls back to the number when no name is sent', async () => {
      byPhone({})
      await processWahaInbound({
        sessionName: 's',
        payload: { id: 'm1', from: `${REAL}@c.us`, body: 'halo', timestamp: 1 },
      })
      expect(contactInserts[0]).toMatchObject({ name: REAL })
    })

    it('fills in the name of an existing contact that only has its number', async () => {
      byPhone({ [REAL]: { id: 'c-1', phone: REAL, name: REAL } })
      await processWahaInbound({
        sessionName: 's',
        payload: {
          id: 'm1',
          from: `${REAL}@c.us`,
          body: 'halo',
          timestamp: 1,
          _data: { pushName: 'Budi Santoso' },
        },
      })
      expect(contactUpdates).toEqual([{ id: 'c-1', values: { name: 'Budi Santoso' } }])
    })

    it('never overwrites a name a person typed in', async () => {
      byPhone({ [REAL]: { id: 'c-1', phone: REAL, name: 'Pak Budi (ICC)' } })
      await processWahaInbound({
        sessionName: 's',
        payload: {
          id: 'm1',
          from: `${REAL}@c.us`,
          body: 'halo',
          timestamp: 1,
          _data: { pushName: 'Budi Santoso' },
        },
      })
      expect(contactUpdates).toEqual([])
    })
  })
})

describe('processWahaOutgoing (messages typed on the phone)', () => {
  beforeEach(() => {
    contactUpdates.length = 0
    contactInserts.length = 0
    messageUpserts.length = 0
    conversationUpdates.length = 0
    upsertEmpty = false
    mirrorWahaMedia.mockReset()
    findExistingContact.mockReset()
    getPhoneForLid.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  const phoneReply = {
    id: 'true_628123456789@c.us_AAA',
    fromMe: true,
    to: `${REAL}@c.us`,
    body: 'Baik, kami proses ya',
    timestamp: 1_700_000_000,
  }

  it('saves a reply typed on the phone as an agent message', async () => {
    byPhone({ [REAL]: { id: 'c-1', phone: REAL } })
    await processWahaOutgoing({ sessionName: 's', payload: phoneReply }, { settleMs: 0 })

    expect(messageUpserts).toHaveLength(1)
    expect(messageUpserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      content_type: 'text',
      content_text: 'Baik, kami proses ya',
      message_id: 'true_628123456789@c.us_AAA',
      status: 'sent',
      created_at: new Date(1_700_000_000 * 1000).toISOString(),
    })
    expect(conversationUpdates[0]).toMatchObject({ last_message_text: 'Baik, kami proses ya' })
    // It must never create a contact or conversation.
    expect(contactInserts).toEqual([])
  })

  it('does nothing when the chat is not a known contact', async () => {
    byPhone({})
    await processWahaOutgoing({ sessionName: 's', payload: phoneReply }, { settleMs: 0 })
    expect(messageUpserts).toEqual([])
    expect(contactInserts).toEqual([])
  })

  it('ignores groups, channels and status updates', async () => {
    byPhone({ [REAL]: { id: 'c-1', phone: REAL } })
    for (const to of ['1203630000000000@g.us', 'status@broadcast', '123@newsletter']) {
      await processWahaOutgoing({ sessionName: 's', payload: { ...phoneReply, to } }, { settleMs: 0 })
    }
    expect(messageUpserts).toEqual([])
  })

  it('does nothing without a message id or any chat id', async () => {
    byPhone({ [REAL]: { id: 'c-1', phone: REAL } })
    await processWahaOutgoing({ sessionName: 's', payload: { ...phoneReply, id: null } }, { settleMs: 0 })
    await processWahaOutgoing(
      { sessionName: 's', payload: { ...phoneReply, to: null, from: null } },
      { settleMs: 0 },
    )
    expect(messageUpserts).toEqual([])
  })

  // WAHA NOWEB omits `to` on messages typed on the phone: the chat id lives
  // in `from` / `_data.key`. Before the fallback these replies were dropped
  // before the contact lookup, so the inbox never learned the chat was
  // answered.
  it('saves a reply typed on the phone when WAHA omits "to" (LID chat)', async () => {
    byPhone({ [REAL]: { id: 'c-1', phone: REAL } })
    await processWahaOutgoing(
      {
        sessionName: 's',
        payload: {
          ...phoneReply,
          to: null,
          from: `${LID}@lid`,
          _data: { key: { remoteJidAlt: `${REAL}@s.whatsapp.net` } },
        },
      },
      { settleMs: 0 },
    )

    expect(messageUpserts).toHaveLength(1)
    expect(messageUpserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      content_text: 'Baik, kami proses ya',
      message_id: 'true_628123456789@c.us_AAA',
    })
    expect(conversationUpdates[0]).toMatchObject({ last_message_text: 'Baik, kami proses ya' })
  })

  it('falls back to the chat id in _data.key.remoteJid when "to" is missing', async () => {
    byPhone({ [REAL]: { id: 'c-1', phone: REAL } })
    await processWahaOutgoing(
      {
        sessionName: 's',
        payload: {
          ...phoneReply,
          to: null,
          from: `${LID}@lid`,
          _data: { key: { remoteJid: `${REAL}@c.us` } },
        },
      },
      { settleMs: 0 },
    )

    expect(messageUpserts).toHaveLength(1)
    expect(getPhoneForLid).not.toHaveBeenCalled()
  })

  it('does not touch the conversation when the message was already saved', async () => {
    byPhone({ [REAL]: { id: 'c-1', phone: REAL } })
    upsertEmpty = true
    await processWahaOutgoing({ sessionName: 's', payload: phoneReply }, { settleMs: 0 })
    expect(messageUpserts).toHaveLength(1)
    expect(conversationUpdates).toEqual([])
  })

  it('resolves a lid chat to the real number before looking up the contact', async () => {
    getPhoneForLid.mockResolvedValue(REAL)
    byPhone({ [REAL]: { id: 'c-1', phone: REAL } })
    await processWahaOutgoing(
      { sessionName: 's', payload: { ...phoneReply, to: `${LID}@lid` } },
      { settleMs: 0 },
    )
    expect(messageUpserts).toHaveLength(1)
  })

  it('stores a media message with its mirrored url and kind', async () => {
    byPhone({ [REAL]: { id: 'c-1', phone: REAL } })
    mirrorWahaMedia.mockResolvedValue('https://cdn.test/chat-media/x.jpg')
    await processWahaOutgoing(
      {
        sessionName: 's',
        payload: {
          ...phoneReply,
          body: null,
          hasMedia: true,
          media: { url: 'http://x/api/files/a.jpg', mimetype: 'image/jpeg' },
        },
      },
      { settleMs: 0 },
    )
    expect(messageUpserts[0]).toMatchObject({
      content_type: 'image',
      media_url: 'https://cdn.test/chat-media/x.jpg',
    })
    expect(conversationUpdates[0]).toMatchObject({ last_message_text: '[image]' })
  })
})
