import { beforeEach, describe, expect, it, vi } from 'vitest'

const applyMessageStatus = vi.fn()
vi.mock('@/lib/whatsapp/message-status-sync', () => ({
  applyMessageStatus: (...a: unknown[]) => applyMessageStatus(...a),
}))

let configRow: { account_id: string } | null = { account_id: 'acct-1' }
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: configRow, error: null }),
      }
      return chain
    },
  }),
}))

import { processWahaAck } from './waha-ack'

describe('processWahaAck', () => {
  beforeEach(() => {
    applyMessageStatus.mockReset()
    configRow = { account_id: 'acct-1' }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('advances the message to delivered / read for the owning account', async () => {
    await processWahaAck({ sessionName: 's', payload: { id: 'true_1@c.us_A', fromMe: true, ack: 2 } })
    expect(applyMessageStatus).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({ wamid: 'true_1@c.us_A', status: 'delivered', failure: null }),
    )
    await processWahaAck({ sessionName: 's', payload: { id: 'true_1@c.us_A', ack: 3 } })
    expect(applyMessageStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({ status: 'read' }),
    )
  })

  it('records a failure with a reason', async () => {
    await processWahaAck({ sessionName: 's', payload: { id: 'x', ack: -1 } })
    expect(applyMessageStatus).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({
        status: 'failed',
        failure: expect.objectContaining({ title: expect.any(String) }),
      }),
    )
  })

  it('ignores pending acks, customer-side receipts and unknown sessions', async () => {
    await processWahaAck({ sessionName: 's', payload: { id: 'x', ack: 0 } })
    await processWahaAck({ sessionName: 's', payload: { id: 'x', fromMe: false, ack: 3 } })
    configRow = null
    await processWahaAck({ sessionName: 'nope', payload: { id: 'x', ack: 3 } })
    expect(applyMessageStatus).not.toHaveBeenCalled()
  })
})
