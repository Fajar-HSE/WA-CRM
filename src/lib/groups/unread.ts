/**
 * "Unread" for WhatsApp groups, kept per browser.
 *
 * Group messages have no per-user read state in the database, so each
 * browser remembers, per group, the time of the newest message it has shown.
 * A group is unread when its latest message is newer than that. Everything
 * here is pure; the storage side is in `seen-store.ts`.
 */

export interface GroupStamp {
  id: string
  last_message_at: string | null
}

/** Group id -> `last_message_at` of the newest message already shown. */
export type SeenMap = Record<string, string>

/** Stands for "nothing seen": any message in the group counts as new. */
const EPOCH = '1970-01-01T00:00:00.000Z'

function ts(iso: string): number {
  return Date.parse(iso)
}

/** Reads a stored map. Anything unexpected becomes an empty map. */
export function parseSeen(raw: string | null): SeenMap {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: SeenMap = {}
    for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
      if (typeof at === 'string' && Number.isFinite(ts(at))) out[id] = at
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Groups this browser has never listed start as "read up to now", so the
 * first visit does not light up every group. A group with no message yet
 * starts at the epoch: its first message is new.
 *
 * Returns the same object when nothing was added.
 */
export function initSeen(groups: GroupStamp[], seen: SeenMap): SeenMap {
  let next: SeenMap | null = null
  for (const g of groups) {
    if (g.id in seen) continue
    next ??= { ...seen }
    next[g.id] = g.last_message_at ?? EPOCH
  }
  return next ?? seen
}

/** Ids of groups whose latest message is newer than what was shown. */
export function unreadGroupIds(groups: GroupStamp[], seen: SeenMap): Set<string> {
  const out = new Set<string>()
  for (const g of groups) {
    const shown = seen[g.id]
    if (!g.last_message_at || shown === undefined) continue
    if (ts(g.last_message_at) > ts(shown)) out.add(g.id)
  }
  return out
}

/**
 * Records that the group's messages were shown up to `lastMessageAt`. Never
 * moves backwards. Returns the same object when nothing changed.
 */
export function markSeen(seen: SeenMap, groupId: string, lastMessageAt: string | null): SeenMap {
  const next = lastMessageAt ?? EPOCH
  const current = seen[groupId]
  if (current !== undefined && ts(current) >= ts(next)) return seen
  return { ...seen, [groupId]: next }
}
