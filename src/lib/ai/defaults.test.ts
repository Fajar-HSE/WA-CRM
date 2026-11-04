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
