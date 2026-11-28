import { describe, expect, it } from 'vitest'
import { HANDOFF_SENTINEL, buildSystemPrompt } from './defaults'

describe('buildSystemPrompt hand-off rules', () => {
  it('draft mode forbids the hand-off marker so a draft is never empty', () => {
    const p = buildSystemPrompt({
      userPrompt: `If asked about schedules reply ${HANDOFF_SENTINEL}`,
      mode: 'draft',
    })
    expect(p).toContain(`Never output ${HANDOFF_SENTINEL}`)
    expect(p).toContain('Always write a best-effort draft')
  })

  it('auto-reply mode still teaches the hand-off protocol', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(p).toContain(`reply with exactly ${HANDOFF_SENTINEL}`)
    expect(p).not.toContain('Always write a best-effort draft')
  })
})

describe('buildSystemPrompt knowledge section', () => {
  it('omits the section without excerpts', () => {
    expect(buildSystemPrompt({ userPrompt: null, mode: 'draft', knowledge: [] })).not.toContain(
      'Knowledge base',
    )
  })

  it('tells the model to use only the excerpts for specifics and to ignore unrelated ones', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'draft', knowledge: ['Harga Rp 1.000.000'] })
    expect(p).toContain('[1] Harga Rp 1.000.000')
    expect(p).toContain('use ONLY what these excerpts say')
    expect(p).toContain('unrelated')
    expect(p).toContain('say you\'ll check and follow up')
  })

  it('makes the auto-reply bot hand off when the excerpts do not cover the question', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', knowledge: ['x'] })
    expect(p).toContain(`reply with exactly ${HANDOFF_SENTINEL}`)
    expect(p).not.toContain("don't cover the question: if they")
  })
})

