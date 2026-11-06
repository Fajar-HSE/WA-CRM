import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Op {
  table: string
  action: string
  values?: Record<string, unknown>
}
const ops: Op[] = []

// Scriptable fake of the service-role client.
const script = {
  invitation: null as Record<string, unknown> | null,
  claimRows: [{ id: 'inv-1' }] as unknown[],
  createUser: { data: { user: { id: 'user-1' } }, error: null } as {
    data: { user: { id: string } } | null
    error: { message: string } | null
  },
  profile: { account_id: 'acct-new' } as { account_id: string } | null,
  grantError: null as { message: string } | null,
  /** accounts.can_create_workspaces of the inviting account. */
  inviterCanCreate: true,
}
const deleteUser = vi.fn()
const createUser = vi.fn()

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        createUser: (...a: unknown[]) => {
          createUser(...a)
          return Promise.resolve(script.createUser)
        },
        deleteUser: (...a: unknown[]) => {
          deleteUser(...a)
          return Promise.resolve({ error: null })
        },
      },
    },
    from: (table: string) => {
      const state: Op = { table, action: 'select' }
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (values: Record<string, unknown>) => {
          state.action = 'update'
          state.values = values
          return chain
        },
        delete: () => {
          state.action = 'delete'
          return chain
        },
        eq: () => chain,
        is: () => chain,
        gt: () => chain,
        maybeSingle: async () => {
          ops.push({ ...state })
          if (table === 'account_invitations') return { data: script.invitation, error: null }
          if (table === 'profiles') return { data: script.profile, error: null }
          if (table === 'accounts') return { data: { can_create_workspaces: script.inviterCanCreate }, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => {
          ops.push({ ...state })
          if (table === 'account_invitations' && state.values?.accepted_at) {
            return resolve({ data: script.claimRows, error: null })
          }
          if (table === 'accounts' && state.values?.can_connect_whatsapp) {
            return resolve({ data: null, error: script.grantError })
          }
          return resolve({ data: null, error: null })
        },
      }
      return chain
    },
  }),
}))

import { POST } from './route'

const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const PAST = new Date(Date.now() - 1000).toISOString()

// A fresh client address per call keeps the per-IP rate limit out of the way.
let nextIp = 1
function call(body: unknown, token = 'tok') {
  return POST(
    new Request('http://x/api/invitations/tok/register', {
      method: 'POST',
      headers: { 'x-forwarded-for': `10.0.0.${nextIp++}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  )
}
const good = { fullName: 'Sari', email: 'Sari@Example.com', password: 'password-1' }

function resetScript() {
  script.invitation = { id: 'inv-1', account_id: 'acct-inviter', kind: 'workspace', accepted_at: null, expires_at: FUTURE }
  script.inviterCanCreate = true
  script.claimRows = [{ id: 'inv-1' }]
  script.createUser = { data: { user: { id: 'user-1' } }, error: null }
  script.profile = { account_id: 'acct-new' }
  script.grantError = null
}

const releases = () =>
  ops.filter((o) => o.table === 'account_invitations' && o.values && 'accepted_at' in o.values && o.values.accepted_at === null)

describe('POST /api/invitations/[token]/register', () => {
  beforeEach(() => {
    ops.length = 0
    createUser.mockReset()
    deleteUser.mockReset()
    resetScript()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('rejects bad input before touching the database', async () => {
    expect((await call({ ...good, email: 'nope' })).status).toBe(400)
    expect((await call({ ...good, password: 'short' })).status).toBe(400)
    expect((await call({ ...good, fullName: '  ' })).status).toBe(400)
    expect(ops).toEqual([])
    expect(createUser).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown', null],
    ['already used', { id: 'inv-1', kind: 'workspace', accepted_at: PAST, expires_at: FUTURE }],
    ['expired', { id: 'inv-1', kind: 'workspace', accepted_at: null, expires_at: PAST }],
  ])('refuses a %s invitation and creates no user', async (_name, inv) => {
    script.invitation = inv
    const res = await call(good)
    expect(res.status).toBe(400)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('registers a workspace invitee: claims once, creates a confirmed user, enables WhatsApp', async () => {
    const res = await call(good)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, kind: 'workspace' })

    expect(createUser).toHaveBeenCalledWith({
      email: 'sari@example.com',
      password: 'password-1',
      email_confirm: true,
      user_metadata: { full_name: 'Sari' },
    })
    const claim = ops.find((o) => o.table === 'account_invitations' && o.values?.accepted_at)
    expect(claim).toBeTruthy()
    expect(ops.find((o) => o.table === 'accounts' && o.values)?.values).toEqual({ can_connect_whatsapp: true })
    expect(
      ops.find((o) => o.table === 'account_invitations' && o.values?.accepted_by_user_id)?.values,
    ).toEqual({ accepted_by_user_id: 'user-1' })
    expect(releases()).toHaveLength(0)
  })

  it('refuses a workspace invitation from an account that may no longer create accounts', async () => {
    script.inviterCanCreate = false
    const res = await call(good)
    expect(res.status).toBe(400)
    expect(createUser).not.toHaveBeenCalled()
    // Nothing was claimed, so there is nothing to release either.
    expect(ops.some((o) => o.values?.accepted_at)).toBe(false)
  })

  it('loses gracefully when someone else claimed the link first', async () => {
    script.claimRows = []
    const res = await call(good)
    expect(res.status).toBe(400)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('releases the invitation when the email is already registered', async () => {
    script.createUser = { data: null, error: { message: 'User already registered' } }
    const res = await call(good)
    expect(res.status).toBe(409)
    expect(releases()).toHaveLength(1)
  })

  it('rolls everything back when the account was not bootstrapped', async () => {
    script.profile = null
    const res = await call(good)
    expect(res.status).toBe(500)
    expect(deleteUser).toHaveBeenCalledWith('user-1')
    expect(releases()).toHaveLength(1)
  })

  it('rolls back the account and user when enabling WhatsApp fails', async () => {
    script.grantError = { message: 'boom' }
    const res = await call(good)
    expect(res.status).toBe(500)
    expect(ops.some((o) => o.table === 'accounts' && o.action === 'delete')).toBe(true)
    expect(deleteUser).toHaveBeenCalledWith('user-1')
    expect(releases()).toHaveLength(1)
  })

  it('does not claim or grant anything for a member invitation', async () => {
    script.invitation = { id: 'inv-2', account_id: 'acct-inviter', kind: 'member', accepted_at: null, expires_at: FUTURE }
    // A member invitation does not depend on the inviter's account-creation right.
    script.inviterCanCreate = false
    const res = await call(good)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, kind: 'member' })
    expect(createUser).toHaveBeenCalledTimes(1)
    expect(ops.some((o) => o.values?.accepted_at)).toBe(false)
    expect(ops.some((o) => o.values?.can_connect_whatsapp)).toBe(false)
  })
})
