// ============================================================
// Public API (v1) message-template helpers: serialization.
//
// Templates are the rows edited under Settings → Templates. Unlike
// knowledge documents there is no indexing step; writes just persist
// the row (and, for Meta accounts, push to the Meta Graph API first,
// mirroring the dashboard's /api/whatsapp/templates routes).
// ============================================================

export const TPL_LIST_SELECT =
  'id, account_id, name, category, language, header_type, header_content, ' +
  'body_text, footer_text, buttons, sample_values, status, meta_template_id, ' +
  'submission_error, rejection_reason, created_at, updated_at';

export interface TemplateRow {
  id: string;
  account_id: string;
  name: string;
  category: string;
  language: string;
  header_type: string | null;
  header_content: string | null;
  header_media_url?: string | null;
  header_handle?: string | null;
  body_text: string;
  footer_text: string | null;
  buttons: unknown;
  sample_values: unknown;
  status: string;
  meta_template_id: string | null;
  submission_error: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function serializeTemplate(row: TemplateRow): TemplateRow {
  return { ...row };
}