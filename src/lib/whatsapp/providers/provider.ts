// ============================================================
// WhatsApp provider abstraction (Phase 1).
// (same content)
// ============================================================

export type WhatsAppProviderName = 'meta' | 'waha' | string

export interface WhatsAppSendResult {
  messageId: string
}

export interface WhatsAppMediaInfo {
  url: string
  mimeType: string
  fileSize: number
}

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: 'image' | 'video' | 'document' | 'audio'
  link: string
  caption?: string
  filename?: string
  mimeType?: string
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language: string
  params?: string[]
  /** Opaque template row (Meta-specific). */
  template?: unknown
  /** Structured per-send values (Meta-specific). */
  messageParams?: unknown
  contextMessageId?: string
}

export interface InteractiveButton {
  id: string
  title: string
}

export interface SendInteractiveButtonsArgs {
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

export interface InteractiveListRow {
  id: string
  title: string
  description?: string
}

export interface InteractiveListSection {
  title: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs {
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

export interface SendReactionArgs {
  to: string
  messageId: string
  emoji: string
}

export interface SendTypingArgs {
  to: string
  messageId?: string
}

export interface GetMediaUrlArgs {
  mediaId: string
}

export interface WhatsAppProviderCredentials {
  phoneNumberId?: string
  accessToken?: string
  sessionName?: string
  baseUrl?: string
  apiKey?: string
}

export interface WhatsAppProvider {
  readonly name: WhatsAppProviderName
  sendText(args: SendTextArgs): Promise<WhatsAppSendResult>
  sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult>
  sendTemplate(args: SendTemplateArgs): Promise<WhatsAppSendResult>
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<WhatsAppSendResult>
  sendInteractiveList(args: SendInteractiveListArgs): Promise<WhatsAppSendResult>
  getMediaUrl(args: GetMediaUrlArgs): Promise<WhatsAppMediaInfo>
  sendReaction?(args: SendReactionArgs): Promise<void>
  sendTypingIndicator?(args: SendTypingArgs): Promise<void>
  getPhoneHealth?(args: { phoneNumberId: string }): Promise<unknown>
  startSession?(sessionName: string): Promise<void>
  stopSession?(sessionName: string): Promise<void>
  getSessionStatus?(sessionName: string): Promise<string>
  getQrCode?(sessionName: string): Promise<string | null>
  logoutSession?(sessionName: string): Promise<void>
  verifyPhoneNumber?(args: unknown): Promise<unknown>
  registerPhoneNumber?(args: unknown): Promise<unknown>
  subscribeWabaToApp?(args: unknown): Promise<unknown>
  listWabaPhoneNumbers?(args: unknown): Promise<unknown>
  getSubscribedApps?(args: unknown): Promise<unknown>
  submitMessageTemplate?(args: unknown): Promise<unknown>
  editMessageTemplate?(args: unknown): Promise<unknown>
  deleteMessageTemplate?(args: unknown): Promise<unknown>
  uploadResumableMedia?(args: unknown): Promise<unknown>
}
