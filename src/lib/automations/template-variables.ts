import { isPlaceholderName } from '@/lib/whatsapp/waha-ids'

/** What a greeting says when the contact has no real name yet ("Halo Kak"). */
export const FALLBACK_NAME = 'Kak'

export interface VariableContact {
  name?: string | null
  phone?: string | null
  email?: string | null
  company?: string | null
}

/** Contact fields an automation template variable can be filled from. */
export const CONTACT_VARIABLE_SOURCES = ['first_name', 'name', 'phone', 'email', 'company'] as const
export type ContactVariableSource = (typeof CONTACT_VARIABLE_SOURCES)[number]

export function contactToken(source: ContactVariableSource): string {
  return `{{contact.${source}}}`
}

function realName(contact: VariableContact | null): string | null {
  const name = contact?.name?.trim() ?? ''
  return name && !isPlaceholderName(name) ? name : null
}

/** First word of the contact's name, or "Kak" when only a number is known. */
export function firstNameOf(contact: VariableContact | null): string {
  const name = realName(contact)
  return name ? name.split(/\s+/)[0] : FALLBACK_NAME
}

/**
 * Replace `{{contact.first_name}}`, `{{contact.name}}`, `{{contact.phone}}`,
 * `{{contact.email}}` and `{{contact.company}}` in a template variable value.
 * Any other `{{contact.*}}` becomes empty. Other text, including other
 * `{{...}}` such as `{{message.text}}`, is left for the engine's own
 * interpolation.
 */
export function fillContactTokens(value: string, contact: VariableContact | null): string {
  return value.replace(/\{\{\s*contact\.(\w+)\s*\}\}/g, (_m, key: string) => {
    switch (key) {
      case 'first_name':
        return firstNameOf(contact)
      case 'name':
        return realName(contact) ?? FALLBACK_NAME
      case 'phone':
        return contact?.phone?.trim() ?? ''
      case 'email':
        return contact?.email?.trim() ?? ''
      case 'company':
        return contact?.company?.trim() ?? ''
      default:
        return ''
    }
  })
}
