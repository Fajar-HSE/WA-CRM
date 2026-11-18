import { describe, expect, it } from 'vitest'

import { initSeen, markSeen, parseSeen, unreadGroupIds } from './unread'

const A = '2026-11-18T10:00:00.000+00:00'
const B = '2026-11-18T10:05:00.000+00:00'

describe('parseSeen', () => {
  it('reads a stored map and drops bad entries', () => {
    expect(parseSeen(JSON.stringify({ g1: A, g2: 5, g3: 'not a date' }))).toEqual({ g1: A })
  })

  it('treats missing or broken storage as empty', () => {
    expect(parseSeen(null)).toEqual({})
    expect(parseSeen('{oops')).toEqual({})
    expect(parseSeen('[]')).toEqual({})
    expect(parseSeen('"text"')).toEqual({})
  })
})

describe('initSeen', () => {
  it('starts new groups at their latest message, so nothing floods on first visit', () => {
    const seen = initSeen([{ id: 'g1', last_message_at: A }], {})
    expect(seen).toEqual({ g1: A })
    expect(unreadGroupIds([{ id: 'g1', last_message_at: A }], seen).size).toBe(0)
  })

  it('makes the first message of an empty group count as new', () => {
    const seen = initSeen([{ id: 'g1', last_message_at: null }], {})
    expect(unreadGroupIds([{ id: 'g1', last_message_at: A }], seen)).toEqual(new Set(['g1']))
  })

  it('keeps existing entries and returns the same object when nothing is added', () => {
    const seen = { g1: A }
    expect(initSeen([{ id: 'g1', last_message_at: B }], seen)).toBe(seen)
  })
})

describe('unreadGroupIds', () => {
  it('flags only groups with a message newer than the one shown', () => {
    const groups = [
      { id: 'g1', last_message_at: B },
      { id: 'g2', last_message_at: A },
      { id: 'g3', last_message_at: null },
    ]
    expect(unreadGroupIds(groups, { g1: A, g2: A, g3: A })).toEqual(new Set(['g1']))
  })

  it('compares moments, not strings, across timezone spellings', () => {
    const same = '2026-11-18T10:00:00Z'
    expect(unreadGroupIds([{ id: 'g1', last_message_at: same }], { g1: A }).size).toBe(0)
  })

  it('ignores a group this browser has not listed yet', () => {
    expect(unreadGroupIds([{ id: 'g9', last_message_at: B }], {}).size).toBe(0)
  })
})

describe('markSeen', () => {
  it('moves forward and clears the unread state', () => {
    const next = markSeen({ g1: A }, 'g1', B)
    expect(next).toEqual({ g1: B })
    expect(unreadGroupIds([{ id: 'g1', last_message_at: B }], next).size).toBe(0)
  })

  it('never moves backwards and returns the same object when unchanged', () => {
    const seen = { g1: B }
    expect(markSeen(seen, 'g1', A)).toBe(seen)
    expect(markSeen(seen, 'g1', B)).toBe(seen)
  })

  it('does not mutate its input', () => {
    const seen = { g1: A }
    markSeen(seen, 'g1', B)
    expect(seen).toEqual({ g1: A })
  })
})
