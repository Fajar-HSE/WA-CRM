import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '6f1c2b0e-4a3d-4f7e-9d2a-0b1c2d3e4f50'
const OTHER_SESSION = 'wacrm-victim-account'

const requireRole = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: String(e) }), { status: 500 }),
}))

const adminWrites: { table: string; op: string }[] = []
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        update: () => {
          adminWrites.push({ table, op: 'update' })
          return chain
        },
        insert: async () => {
          adminWrites.push({ table, op: 'insert' })
          return { error: null }
        },
        eq: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
      }
      return chain
    },
  }),
}))

const sessions: string[] = []
vi.mock('@/lib/whatsapp/providers/waha', () => {
  class WahaHttpError extends Error {
    constructor(m: string, public status: number) {
      super(m)
    }
  }
  class WahaWhatsAppProvider {
    sessionName: string
    constructor(c: { sessionName: string }) {
      this.sessionName = c.sessionName
      sessions.push(c.sessionName)
    }
    async getSessionStatus() {
      return 'SCAN_QR_CODE'
    }
    async getQrCode() {
      return 'data:image/png;base64,QQ=='
    }
    async logoutSession() {}
    async ensureSession() {}
  }
  return { WahaHttpError, WahaWhatsAppProvider }
})

import { DELETE, GET, POST } from './route'

function makeCtx(row: Record<string, unknown> | null, canConnect = true) {
  const chainFor = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data: table === 'accounts' ? { can_connect_whatsapp: canConnect } : row,
        error: null,
      }),
    }
    return chain
  }
  return {
    supabase: { from: (table: string) => chainFor(table) },
    userId: 'user-1',
    accountId: ACCOUNT,
    role: 'admin',
    account: { id: ACCOUNT, name: 'A' },
  }
}

const own = `wacrm-${ACCOUNT.replace(/-/g, '')}`

describe('WAHA session route tenancy', () => {
  beforeEach(() => {
    sessions.length = 0
    adminWrites.length = 0
    process.env.WAHA_BASE_URL = 'http://waha:3000'
    process.env.WAHA_API_KEY = 'k'
    process.env.WAHA_WEBHOOK_SECRET = 's'
    delete process.env.WAHA_SESSION_NAME
    requireRole.mockResolvedValue(makeCtx({ id: 'cfg', provider: 'waha', waha_session_name: own }))
  })

  it('ignores a client-supplied session name on GET', async () => {
    const res = await GET(new Request(`http://x/api/whatsapp/waha/session?name=${OTHER_SESSION}`))
    const json = await res.json()
    expect(json.sessionName).toBe(own)
    expect(sessions).toEqual([own])
  })

  it('ignores a client-supplied session name on POST', async () => {
    const res = await POST(
      new Request('http://x/api/whatsapp/waha/session', {
        method: 'POST',
        body: JSON.stringify({ name: OTHER_SESSION, sessionName: OTHER_SESSION }),
      }),
    )
    expect((await res.json()).sessionName).toBe(own)
    expect(sessions).toEqual([own])
  })

  it('ignores a client-supplied session name on DELETE', async () => {
    const res = await DELETE(new Request(`http://x/api/whatsapp/waha/session?name=${OTHER_SESSION}`))
    expect((await res.json()).sessionName).toBe(own)
    expect(sessions).toEqual([own])
  })

  it('refuses to start without a webhook secret', async () => {
    delete process.env.WAHA_WEBHOOK_SECRET
    const res = await POST(new Request('http://x/api/whatsapp/waha/session', { method: 'POST' }))
    expect(res.status).toBe(500)
    expect(sessions).toEqual([])
  })

  it('reports an unconfigured account without touching WAHA', async () => {
    requireRole.mockResolvedValue(makeCtx(null))
    const json = await (await GET(new Request('http://x/api/whatsapp/waha/session'))).json()
    expect(json.configured).toBe(false)
    expect(sessions).toEqual([])
  })

  it('refuses to create a session for an account that was not invited', async () => {
    requireRole.mockResolvedValue(makeCtx(null, false))
    const res = await POST(new Request('http://x/api/whatsapp/waha/session', { method: 'POST' }))
    expect(res.status).toBe(403)
    expect(sessions).toEqual([])
    expect(adminWrites).toEqual([])
  })

  it('tells the page whether the account may connect', async () => {
    requireRole.mockResolvedValue(makeCtx(null, false))
    const json = await (await GET(new Request('http://x/api/whatsapp/waha/session'))).json()
    expect(json.canConnect).toBe(false)
    requireRole.mockResolvedValue(makeCtx(null, true))
    const ok = await (await GET(new Request('http://x/api/whatsapp/waha/session'))).json()
    expect(ok.canConnect).toBe(true)
  })

  it('writes the config row with the service role, not the browser session', async () => {
    requireRole.mockResolvedValue(makeCtx(null, true))
    await POST(new Request('http://x/api/whatsapp/waha/session', { method: 'POST' }))
    expect(adminWrites.some((w) => w.table === 'whatsapp_config' && w.op === 'insert')).toBe(true)
  })
})
