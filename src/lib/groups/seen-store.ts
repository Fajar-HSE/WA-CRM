import { parseSeen, type SeenMap } from '@/lib/groups/unread'

/**
 * Browser storage for the per-group "shown up to" times (see `unread.ts`).
 * One entry per account, so switching accounts in the same browser does not
 * mix the lists. Browser-only: call from effects and event handlers.
 */

const CHANGE_EVENT = 'wa-crm:groups-seen'

// Used when localStorage is blocked, so the indicator still works for the
// life of the page.
const memory = new Map<string, SeenMap>()

function key(accountId: string): string {
  return `wa-crm:groups-seen:${accountId}`
}

export function loadSeen(accountId: string): SeenMap {
  try {
    const raw = window.localStorage.getItem(key(accountId))
    if (raw !== null) return parseSeen(raw)
  } catch {
    // Storage blocked: fall through to memory.
  }
  return memory.get(accountId) ?? {}
}

export function saveSeen(accountId: string, seen: SeenMap): void {
  memory.set(accountId, seen)
  try {
    window.localStorage.setItem(key(accountId), JSON.stringify(seen))
  } catch {
    // Quota or blocked storage: memory still holds it.
  }
  // Tells other listeners in this tab; other tabs get the native `storage` event.
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeSeen(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}
