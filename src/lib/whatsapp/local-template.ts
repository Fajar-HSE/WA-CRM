// ============================================================
// Local message templates.
//
// This fork sends through WAHA, which has no template approval: a
// "template" is just reusable text with {{placeholders}}. Local templates
// are stored like Meta ones but never leave the app; they are APPROVED the
// moment they are saved and carry a `local-` id instead of Meta's.
// ============================================================

/** Prefix of `message_templates.meta_template_id` for a template that never touched Meta. */
export const LOCAL_TEMPLATE_PREFIX = 'local-'

export function isLocalTemplateId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(LOCAL_TEMPLATE_PREFIX)
}

export function newLocalTemplateId(): string {
  return `${LOCAL_TEMPLATE_PREFIX}${crypto.randomUUID()}`
}

/**
 * True when templates for this account stay local: it sends through WAHA,
 * or has no WhatsApp connection yet (this fork is WAHA-only). An account
 * that still holds a Meta configuration goes through Meta review as before.
 */
export function usesLocalTemplates(
  config: { provider?: string | null } | null | undefined,
): boolean {
  if (!config) return true
  return (config.provider ?? 'meta') === 'waha'
}
