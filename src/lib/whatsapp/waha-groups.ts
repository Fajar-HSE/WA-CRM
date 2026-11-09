import type { SupabaseClient } from '@supabase/supabase-js'

import { findExistingContact } from '@/lib/contacts/dedupe'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import type { WahaGroupParticipant } from '@/lib/whatsapp/providers/waha'
import { digitsOf, phoneFromJid } from '@/lib/whatsapp/waha-ids'

/** True for a WhatsApp group chat id (`<digits>@g.us`). */
export function isGroupChatId(chatId: unknown): boolean {
  return typeof chatId === 'string' && /@g\.us$/i.test(chatId.trim())
}

export interface GroupMember {
  /** Chat id WAHA reported (`@c.us` or an opaque `@lid`). */
  id: string
  /** Real phone number (digits), or null when WhatsApp keeps it hidden. */
  phone: string | null
  role: string | null
  isAdmin: boolean
}

export interface MemberDiagnostics {
  /** Property names in the members' records (names only). */
  fields: string[]
  /** Members by kind of id WAHA reported. */
  ids: { phone: number; hidden: number; other: number }
  /** Numbers that were already in the members' own records. */
  inRecord: number
  groupFallback: 'not_needed' | 'used' | 'failed' | 'unknown'
  lidLookup: { tried: number; found: number; empty: number; errors: number; firstError: string | null }
}

export interface ResolvedMembers {
  members: GroupMember[]
  total: number
  /** Members whose phone number could not be found. */
  unresolved: number
  /** True when some LIDs were not looked up because the limit was reached. */
  truncated: boolean
  /** Counts and field names only: never a phone number. */
  diagnostics: MemberDiagnostics
}

type SourceParticipant = Pick<WahaGroupParticipant, 'id' | 'role'> & { phone?: string | null }

export interface MemberSource {
  listGroupParticipants(groupId: string): Promise<SourceParticipant[]>
  /** Preferred when present: also reports field names and the group fallback. */
  listGroupParticipantsDetailed?(groupId: string): Promise<{
    participants: SourceParticipant[]
    fields: string[]
    groupFallback: 'not_needed' | 'used' | 'failed'
  }>
  getPhoneForLid(lid: string): Promise<string | null>
  /** Preferred when present: says why a lookup came back empty. */
  getLidMapping?(lid: string): Promise<{ phone: string | null; error: string | null }>
}

const MAX_LID_LOOKUPS = 300
const LOOKUP_CONCURRENCY = 8

/**
 * The members of a group with their phone numbers.
 *
 * WhatsApp increasingly shows a member as an opaque `@lid` id instead of a
 * number. The number is taken from the member's own record when WAHA put it
 * there, otherwise looked up one by one (WAHA keeps the mapping only for
 * people it has seen); some stay unknown, and the result says how many.
 */
export async function resolveGroupMembers(
  source: MemberSource,
  groupId: string,
  opts: { maxLidLookups?: number } = {},
): Promise<ResolvedMembers> {
  let participants: SourceParticipant[]
  let fields: string[] = []
  let groupFallback: MemberDiagnostics['groupFallback'] = 'unknown'
  if (source.listGroupParticipantsDetailed) {
    const d = await source.listGroupParticipantsDetailed(groupId)
    participants = d.participants
    fields = d.fields
    groupFallback = d.groupFallback
  } else {
    participants = await source.listGroupParticipants(groupId)
  }
  const maxLookups = opts.maxLidLookups ?? MAX_LID_LOOKUPS

  const members: GroupMember[] = participants.map((p) => {
    const role = p.role
    return {
      id: p.id,
      phone: p.phone || phoneFromJid(p.id),
      role,
      isAdmin: role === 'admin' || role === 'superadmin',
    }
  })

  const diagnostics: MemberDiagnostics = {
    fields,
    ids: {
      phone: participants.filter((p) => phoneFromJid(p.id)).length,
      hidden: participants.filter((p) => p.id.endsWith('@lid')).length,
      other: participants.filter((p) => !phoneFromJid(p.id) && !p.id.endsWith('@lid')).length,
    },
    inRecord: participants.filter((p) => p.phone && !phoneFromJid(p.id)).length,
    groupFallback,
    lidLookup: { tried: 0, found: 0, empty: 0, errors: 0, firstError: null },
  }

  const pending = members.filter((m) => m.phone === null && m.id.endsWith('@lid'))
  const toLookUp = pending.slice(0, maxLookups)
  const lookup = async (id: string) => {
    if (source.getLidMapping) return source.getLidMapping(id)
    return { phone: await source.getPhoneForLid(id), error: null }
  }
  for (let i = 0; i < toLookUp.length; i += LOOKUP_CONCURRENCY) {
    await Promise.all(
      toLookUp.slice(i, i + LOOKUP_CONCURRENCY).map(async (m) => {
        diagnostics.lidLookup.tried += 1
        try {
          const r = await lookup(m.id)
          m.phone = r.phone
          if (r.phone) diagnostics.lidLookup.found += 1
          else if (r.error) {
            diagnostics.lidLookup.errors += 1
            diagnostics.lidLookup.firstError ??= r.error
          } else diagnostics.lidLookup.empty += 1
        } catch {
          diagnostics.lidLookup.errors += 1
          diagnostics.lidLookup.firstError ??= 'error'
        }
      }),
    )
  }

  return {
    members,
    total: members.length,
    unresolved: members.filter((m) => m.phone === null).length,
    truncated: pending.length > toLookUp.length,
    diagnostics,
  }
}

export interface GrabInput {
  db: SupabaseClient
  accountId: string
  userId: string
  groupName: string
  members: { phone: string; name?: string | null }[]
}

export interface GrabResult {
  created: number
  existing: number
  tagged: number
  invalid: number
  tagName: string
}

/** Members accepted per request; the dialog sends larger groups in slices. */
export const GRAB_BATCH_LIMIT = 150

const TAG_COLOR = '#64748b'
const FALLBACK_TAG = 'Grup WhatsApp'
const MAX_TAG_LENGTH = 40

export function tagNameForGroup(groupName: string): string {
  const name = groupName.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH)
  return name || FALLBACK_TAG
}

function validPhone(raw: string): string | null {
  const digits = digitsOf(raw)
  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

async function ensureTag(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  name: string,
): Promise<string> {
  const { data: found } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', name)
    .maybeSingle()
  if (found?.id) return found.id as string

  const { data: created, error } = await db
    .from('tags')
    .insert({ account_id: accountId, user_id: userId, name, color: TAG_COLOR })
    .select('id')
    .single()
  if (error || !created) throw new Error(error?.message ?? 'Could not create the tag')
  return created.id as string
}

/**
 * Save chosen group members as contacts, each tagged with the group's name.
 *
 * Numbers that are already contacts are left as they are (only tagged), so
 * a name someone typed is never overwritten. New contacts get their number as
 * the name; the inbound handler replaces that with the WhatsApp profile name
 * as soon as the person writes in. Nothing is sent to anyone.
 */
export async function grabMembersToContacts(input: GrabInput): Promise<GrabResult> {
  const { db, accountId, userId } = input
  const tagName = tagNameForGroup(input.groupName)
  const tagId = await ensureTag(db, accountId, userId, tagName)

  const seen = new Set<string>()
  const result: GrabResult = { created: 0, existing: 0, tagged: 0, invalid: 0, tagName }

  for (const m of input.members.slice(0, GRAB_BATCH_LIMIT)) {
    const phone = validPhone(m.phone)
    if (!phone) {
      result.invalid += 1
      continue
    }
    if (seen.has(phone)) continue
    seen.add(phone)

    let contact = await findExistingContact(db, accountId, phone)
    if (contact) {
      result.existing += 1
    } else {
      const name = m.name?.trim() || phone
      const { data: inserted, error } = await db
        .from('contacts')
        .insert({ account_id: accountId, user_id: userId, phone, name })
        .select('id')
        .single()
      if (error || !inserted) {
        // A concurrent import of the same number: pick up the row that won.
        contact = await findExistingContact(db, accountId, phone)
        if (!contact) {
          result.invalid += 1
          continue
        }
        result.existing += 1
      } else {
        contact = { id: inserted.id as string, phone }
        result.created += 1
      }
    }

    const added = await addContactTagIfAbsent(db, {
      accountId,
      contactId: contact.id,
      tagId,
    })
    if (added) result.tagged += 1
  }

  return result
}
