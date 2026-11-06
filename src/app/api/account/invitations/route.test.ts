import { beforeEach, describe, expect, it, vi } from 'vitest'

const inserts: Record<string, unknown>[] = []
let canCreateWorkspaces: boolean | null = true
let accountQueryError: { message: string } | null = null

function makeCtx() {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data: table === 'accounts' ? { can_create_workspaces: canCreateWorkspaces } : null,
        error: table === 'accounts' ? accountQueryError : null,
      }),
      insert: (row: Record<string, unknown>) => {
        inserts.push(row)
        return chain
      },
      single: async () => ({
        data: { id: 'inv-1', ...inserts[inserts.length - 1] },
        error: null,
      }),
    }
    return chain
  }
  return {
    supabase: { from: (table: string) => chainFor(table) },
    userId: 'user-1',
    accountId: 'acct-1',
    role: 'owner',
    account: { id: 'acct-1', name: 'Acme' },
  }
}

const requireRole = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: String(e) }), { status: 500 }),
}))

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function create(body: Record<string, unknown>) {
  return POST(
    new Request('https://crm.example.com/api/account/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'crm.example.com' },
      body: JSON.stringify(body),
    }),
  )
}

describe('POST /api/account/invitations — who may create new accounts', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
    inserts.length = 0
    canCreateWorkspaces = true
    accountQueryError = null
    requireRole.mockReset()
    requireRole.mockImplementation(async () => makeCtx())
  })

  it('lets the platform account create a workspace invitation', async () => {
    const res = await create({ kind: 'workspace', expiresInDays: 7 })
    expect(res.status).toBe(201)
    expect(inserts[0]).toMatchObject({ kind: 'workspace', account_id: 'acct-1' })
  })

  it('refuses a workspace invitation from an account without the right', async () => {
    canCreateWorkspaces = false
    const res = await create({ kind: 'workspace' })
    expect(res.status).toBe(403)
    expect(inserts).toHaveLength(0)
  })

  it('refuses it when the right cannot be read (e.g. migration not applied)', async () => {
    canCreateWorkspaces = null
    accountQueryError = { message: 'column does not exist' }
    const res = await create({ kind: 'workspace' })
    expect(res.status).toBe(403)
    expect(inserts).toHaveLength(0)
  })

  it('always lets any owner invite a teammate into their own account', async () => {
    canCreateWorkspaces = false
    const res = await create({ kind: 'member', role: 'agent' })
    expect(res.status).toBe(201)
    expect(inserts[0]).toMatchObject({ kind: 'member', role: 'agent' })
  })

  it('treats an unspecified kind as a member invitation, never a new account', async () => {
    canCreateWorkspaces = false
    const res = await create({ role: 'viewer' })
    expect(res.status).toBe(201)
    expect(inserts[0]).toMatchObject({ kind: 'member' })
  })
})
