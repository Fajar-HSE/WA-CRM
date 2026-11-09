import { describe, expect, it } from 'vitest'

import {
  CONTACT_VARIABLE_SOURCES,
  FALLBACK_NAME,
  contactToken,
  fillContactTokens,
  firstNameOf,
} from './template-variables'

const budi = { name: 'Budi Santoso', phone: '6281234567890', email: 'budi@example.com', company: 'PT Maju' }

describe('firstNameOf', () => {
  it('takes the first word of a real name', () => {
    expect(firstNameOf(budi)).toBe('Budi')
  })

  it('falls back to "Kak" when the name is missing or only a number', () => {
    expect(firstNameOf(null)).toBe(FALLBACK_NAME)
    expect(firstNameOf({ name: '' })).toBe(FALLBACK_NAME)
    expect(firstNameOf({ name: '6281117047678' })).toBe(FALLBACK_NAME)
    expect(firstNameOf({ name: '+62 811-1704-7678' })).toBe(FALLBACK_NAME)
  })
})

describe('fillContactTokens', () => {
  it('fills every contact field', () => {
    expect(fillContactTokens('{{contact.first_name}} | {{contact.name}}', budi)).toBe('Budi | Budi Santoso')
    expect(fillContactTokens('{{contact.phone}} {{contact.email}} {{contact.company}}', budi)).toBe(
      '6281234567890 budi@example.com PT Maju',
    )
  })

  it('tolerates spaces inside the braces', () => {
    expect(fillContactTokens('{{ contact.first_name }}', budi)).toBe('Budi')
  })

  it('mixes tokens with plain text', () => {
    expect(fillContactTokens('Pak {{contact.first_name}}', budi)).toBe('Pak Budi')
    expect(fillContactTokens('tetap', budi)).toBe('tetap')
  })

  it('uses "Kak" for the name tokens and empty for the rest without a contact', () => {
    expect(fillContactTokens('{{contact.first_name}}/{{contact.name}}', null)).toBe('Kak/Kak')
    expect(fillContactTokens('{{contact.phone}}|{{contact.email}}|{{contact.company}}', {})).toBe('||')
  })

  it('blanks an unknown contact field and leaves other braces for the engine', () => {
    expect(fillContactTokens('{{contact.nope}}', budi)).toBe('')
    expect(fillContactTokens('{{message.text}} {{vars.x}}', budi)).toBe('{{message.text}} {{vars.x}}')
  })

  it('builds the token the builder stores for each source', () => {
    for (const s of CONTACT_VARIABLE_SOURCES) {
      expect(fillContactTokens(contactToken(s), budi)).not.toContain('{{')
    }
    expect(contactToken('first_name')).toBe('{{contact.first_name}}')
  })
})
