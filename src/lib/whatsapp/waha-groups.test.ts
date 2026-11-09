import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ find: vi.fn(), addTag: vi.fn() }))
vi.mock('@/lib/contacts/dedupe', () => ({ findExistingContact: (...a: unknown[]) => h.find(...a) }))
vi.mock('@/lib/contacts/tag-write', () => ({ addContactTagIfAbsent: (...a: unknown[]) => h.addTag(...a) }))

import {
  GRAB_BATCH_LIMIT,
  grabMembersToContacts,
  isGroupChatId,
  resolveGroupMembers,
  tagNameForGroup,
} from './waha-groups'
import { parseWahaGroups, parseWahaParticipants } from './providers/waha'

describe('isGroupChatId', () => {
  it('matches group ids only', () => {
    expect(isGroupChatId('120363012345678901@g.us')).toBe(true)
    expect(isGroupChatId('628123@c.us')).toBe(false)
    expect(isGroupChatId('status@broadcast')).toBe(false)
    expect(isGroupChatId(undefined)).toBe(false)
  })
})

describe('parseWahaGroups / parseWahaParticipants', () => {
  it('reads an array of groups with a subject and member count', () => {
    const out = parseWahaGroups([
      { id: '1203@g.us', subject: ' Peserta K3 ', participants: [{}, {}, {}] },
      { id: { _serialized: '1204@g.us' }, name: 'Alumni', size: 12 },
      { id: '628@c.us', subject: 'not a group' },
    ])
    expect(out).toEqual([
      { id: '1203@g.us', subject: 'Peserta K3', size: 3 },
      { id: '1204@g.us', subject: 'Alumni', size: 12 },
    ])
  })

  it('reads an object keyed by id and ignores junk', () => {
    expect(parseWahaGroups({ a: { id: '1@g.us', subject: 'X' }, b: null })).toEqual([
      { id: '1@g.us', subject: 'X', size: null },
    ])
    expect(parseWahaGroups(null)).toEqual([])
    expect(parseWahaGroups('nope')).toEqual([])
  })

  it('reads participants with roles, from an array or a {participants} object', () => {
    const list = [
      { id: '111@c.us', role: 'participant' },
      { id: '222@lid', role: 'superadmin' },
    ]
    expect(parseWahaParticipants(list)).toEqual([
      { id: '111@c.us', role: 'participant' },
      { id: '222@lid', role: 'superadmin' },
    ])
    expect(parseWahaParticipants({ participants: list })).toHaveLength(2)
    expect(parseWahaParticipants(undefined)).toEqual([])
  })
})

describe('resolveGroupMembers', () => {
  it('uses numbers as given and looks up hidden ones', async () => {
    const source = {
      listGroupParticipants: async () => [
        { id: '6281111111111@c.us', role: 'admin' },
        { id: '30601675599946@lid', role: 'participant' },
        { id: '99999999999999@lid', role: 'participant' },
      ],
      getPhoneForLid: vi.fn(async (lid: string) => (lid.startsWith('3060') ? '6282222222222' : null)),
    }
    const res = await resolveGroupMembers(source, '1203@g.us')
    expect(res.total).toBe(3)
    expect(res.members.map((m) => m.phone)).toEqual(['6281111111111', '6282222222222', null])
    expect(res.members[0].isAdmin).toBe(true)
    expect(res.unresolved).toBe(1)
    expect(res.truncated).toBe(false)
    expect(source.getPhoneForLid).toHaveBeenCalledTimes(2)
  })

  it('stops looking up after the limit and says so', async () => {
    const source = {
      listGroupParticipants: async () => [
        { id: '1@lid', role: null },
        { id: '2@lid', role: null },
        { id: '3@lid', role: null },
      ],
      getPhoneForLid: vi.fn(async () => '6281234567890'),
    }
    const res = await resolveGroupMembers(source, '1203@g.us', { maxLidLookups: 2 })
    expect(source.getPhoneForLid).toHaveBeenCalledTimes(2)
    expect(res.truncated).toBe(true)
    expect(res.unresolved).toBe(1)
  })

  it('treats a failing lookup as unknown', async () => {
    const source = {
      listGroupParticipants: async () => [{ id: '1@lid', role: null }],
      getPhoneForLid: async () => {
        throw new Error('boom')
      },
    }
    const res = await resolveGroupMembers(source, '1203@g.us')
    expect(res.members[0].phone).toBeNull()
  })
})

describe('tagNameForGroup', () => {
  it('trims, collapses spaces, caps length and falls back', () => {
    expect(tagNameForGroup('  Peserta   K3  ')).toBe('Peserta K3')
    expect(tagNameForGroup('x'.repeat(80))).toHaveLength(40)
    expect(tagNameForGroup('   ')).toBe('Grup WhatsApp')
  })
})

function makeDb(opts: { tagId?: string | null } = {}) {
  const inserts: { table: string; row: Record<string, unknown> }[] = []
  let n = 0
  const db = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: table === 'tags' && opts.tagId !== null ? { id: opts.tagId ?? 'tag-1' } : null,
          error: null,
        }),
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row })
          return chain
        },
        single: async () => ({ data: { id: `${table}-${++n}` }, error: null }),
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { db, inserts }
}

describe('grabMembersToContacts', () => {
  beforeEach(() => {
    h.find.mockReset()
    h.addTag.mockReset()
    h.addTag.mockResolvedValue(true)
  })

  it('creates new contacts, tags every one, and leaves existing ones alone', async () => {
    h.find.mockImplementation(async (_db, _acct, phone: string) =>
      phone === '6282222222222' ? { id: 'c-existing', phone } : null,
    )
    const { db, inserts } = makeDb()
    const res = await grabMembersToContacts({
      db,
      accountId: 'acct-1',
      userId: 'u-1',
      groupName: 'Peserta K3',
      members: [
        { phone: '+62 811-1111-1111' },
        { phone: '6282222222222', name: 'Sudah Ada' },
        { phone: '6282222222222' },
        { phone: '123' },
      ],
    })
    expect(res).toEqual({ created: 1, existing: 1, tagged: 2, invalid: 1, tagName: 'Peserta K3' })

    const contactInserts = inserts.filter((i) => i.table === 'contacts')
    expect(contactInserts).toHaveLength(1)
    expect(contactInserts[0].row).toMatchObject({
      account_id: 'acct-1',
      user_id: 'u-1',
      phone: '6281111111111',
      name: '6281111111111',
    })
    expect(h.addTag).toHaveBeenCalledTimes(2)
    expect(h.addTag.mock.calls[0][1]).toMatchObject({ accountId: 'acct-1', tagId: 'tag-1' })
  })

  it('creates the tag when the account does not have it yet', async () => {
    h.find.mockResolvedValue({ id: 'c-1', phone: '6281111111111' })
    const { db, inserts } = makeDb({ tagId: null })
    await grabMembersToContacts({
      db,
      accountId: 'acct-1',
      userId: 'u-1',
      groupName: 'Alumni',
      members: [{ phone: '6281111111111' }],
    })
    const tag = inserts.find((i) => i.table === 'tags')
    expect(tag?.row).toMatchObject({ account_id: 'acct-1', name: 'Alumni' })
  })

  it('does not count a tag that was already on the contact', async () => {
    h.find.mockResolvedValue({ id: 'c-1', phone: '6281111111111' })
    h.addTag.mockResolvedValue(false)
    const { db } = makeDb()
    const res = await grabMembersToContacts({
      db,
      accountId: 'a',
      userId: 'u',
      groupName: 'G',
      members: [{ phone: '6281111111111' }],
    })
    expect(res.tagged).toBe(0)
    expect(res.existing).toBe(1)
  })

  it('processes no more than one batch', async () => {
    h.find.mockResolvedValue({ id: 'c', phone: 'x' })
    const { db } = makeDb()
    const members = Array.from({ length: GRAB_BATCH_LIMIT + 20 }, (_, i) => ({
      phone: `62811${String(1000000 + i)}`,
    }))
    const res = await grabMembersToContacts({ db, accountId: 'a', userId: 'u', groupName: 'G', members })
    expect(res.existing).toBe(GRAB_BATCH_LIMIT)
  })
})
