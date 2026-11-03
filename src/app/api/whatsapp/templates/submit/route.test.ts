import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Write = {
  kind: 'insert' | 'update'
  row: Record<string, unknown>
  filters: [string, string, unknown][]
}

const writes: Write[] = []
let existingTemplate: Record<string, unknown> | null = null
/** What the account's whatsapp_config row looks like; `null` means none saved yet. */
let configRow: Record<string, unknown> | null = { waba_id: 'waba-1', access_token: 'enc' }

function makeSupabaseMock() {
  function builder(table: string) {
    let write: Write | null = null
    const result = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1', account_role: 'admin' }, error: null }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        case 'whatsapp_config':
          return { data: configRow, error: null }
        case 'message_templates':
          return write
            ? { data: { id: 'tpl-1', ...write.row }, error: null }
            : { data: existingTemplate, error: null }
        default:
          return { data: null, error: null }
      }
    }
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    for (const op of ['eq', 'is']) {
      b[op] = vi.fn((column: string, value: unknown) => {
        write?.filters.push([op, column, value])
        return b
      })
    }
    for (const kind of ['insert', 'update'] as const) {
      b[kind] = vi.fn((row: Record<string, unknown>) => {
        write = { kind, row, filters: [] }
        writes.push(write)
        return b
      })
    }
    b.single = vi.fn(async () => result())
    b.maybeSingle = vi.fn(async () => result())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

const submitMessageTemplate = vi.fn()

vi.mock('@/lib/whatsapp/meta-api', () => ({
  submitMessageTemplate: (...args: unknown[]) => submitMessageTemplate(...args),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'token'),
}))

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function submit() {
  return POST(
    new Request('http://localhost/api/whatsapp/templates/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'order_update',
        category: 'Utility',
        language: 'en_US',
        body_text: 'Your order shipped.',
      }),
    }),
  )
}

beforeEach(() => {
  __resetRateLimitForTests()
  writes.length = 0
  existingTemplate = null
  configRow = { waba_id: 'waba-1', access_token: 'enc' }
  submitMessageTemplate.mockReset()
  supabaseMock = makeSupabaseMock()
  vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'true')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/whatsapp/templates/submit', () => {
  it('inserts a new template with the caller as author', async () => {
    const res = await submit()

    expect(res.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe('insert')
    expect(writes[0].row).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      name: 'order_update',
      language: 'en_US',
    })
  })

  it('refuses to create a template whose name and language already exist linked to Meta', async () => {
    vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'false')
    existingTemplate = { id: 'tpl-teammate', status: 'APPROVED', meta_template_id: 'meta-9' }

    const res = await submit()

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('order_update')
    expect(submitMessageTemplate).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it('refuses a create over a non-draft row even without a Meta id', async () => {
    existingTemplate = { id: 'tpl-2', status: 'PENDING', meta_template_id: null }

    const res = await submit()

    expect(res.status).toBe(409)
    expect(writes).toHaveLength(0)
  })

  it('re-submits an unsubmitted draft in place without rewriting its author', async () => {
    existingTemplate = { id: 'tpl-draft', status: 'DRAFT', meta_template_id: null }

    const res = await submit()

    expect(res.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe('update')
    expect(writes[0].row).not.toHaveProperty('user_id')
    expect(writes[0].row).toMatchObject({ status: 'PENDING' })
    expect(writes[0].filters).toEqual(
      expect.arrayContaining([
        ['eq', 'id', 'tpl-draft'],
        ['eq', 'account_id', 'acct-1'],
        ['is', 'meta_template_id', null],
      ]),
    )
  })

  it('records a Meta rejection on the existing draft only while it is still unlinked', async () => {
    vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'false')
    existingTemplate = { id: 'tpl-draft', status: 'DRAFT', meta_template_id: null }
    submitMessageTemplate.mockRejectedValue(new Error('Meta said no'))

    const res = await submit()

    expect(res.status).toBe(502)
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe('update')
    expect(writes[0].row).toMatchObject({
      status: 'DRAFT',
      meta_template_id: null,
      submission_error: 'Meta said no',
    })
    expect(writes[0].row).not.toHaveProperty('user_id')
    expect(writes[0].filters).toContainEqual(['is', 'meta_template_id', null])
  })

  it('records a Meta rejection of a brand-new template as an inserted draft', async () => {
    vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'false')
    submitMessageTemplate.mockRejectedValue(new Error('Meta said no'))

    const res = await submit()

    expect(res.status).toBe(502)
    expect(writes).toHaveLength(1)
    expect(writes[0].kind).toBe('insert')
    expect(writes[0].row).toMatchObject({ status: 'DRAFT', user_id: 'user-1' })
  })
})

describe('local (WAHA) templates', () => {
  it.each([
    ['a WAHA account', { provider: 'waha', waba_id: null, access_token: '' }],
    ['an account with no WhatsApp connection yet', null],
  ])('saves a template for %s locally, approved at once, without calling Meta', async (_name, cfg) => {
    vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'false')
    configRow = cfg

    const res = await submit()

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, local: true })
    expect(submitMessageTemplate).not.toHaveBeenCalled()
    expect(writes).toHaveLength(1)
    expect(writes[0].row).toMatchObject({ status: 'APPROVED', name: 'order_update' })
    expect(String(writes[0].row.meta_template_id)).toMatch(/^local-/)
  })

  it('still sends a template to Meta for an account that holds a Meta configuration', async () => {
    vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'false')
    configRow = { provider: 'meta', waba_id: 'waba-1', access_token: 'enc' }
    submitMessageTemplate.mockResolvedValue({ id: 'meta-77', status: 'PENDING' })

    const res = await submit()

    expect(res.status).toBe(200)
    expect(submitMessageTemplate).toHaveBeenCalledTimes(1)
    expect(writes[0].row).toMatchObject({ status: 'PENDING', meta_template_id: 'meta-77' })
  })
})

