import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendReactionMessage,
  sendTypingIndicator,
  getMediaUrl,
  getPhoneNumberHealth,
} from '@/lib/whatsapp/meta-api'
import type { WhatsAppProvider, WhatsAppProviderCredentials, WhatsAppSendResult, WhatsAppMediaInfo } from './provider'

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'meta' as const
  private readonly phoneNumberId: string
  private readonly accessToken: string

  constructor(creds: WhatsAppProviderCredentials) {
    if (!creds.phoneNumberId) throw new Error('MetaWhatsAppProvider requires phoneNumberId')
    if (!creds.accessToken) throw new Error('MetaWhatsAppProvider requires accessToken')
    this.phoneNumberId = creds.phoneNumberId
    this.accessToken = creds.accessToken
  }

  async sendText(args: { to: string; text: string; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    const r = await sendTextMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      text: args.text,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  async sendMedia(args: { to: string; kind: 'image' | 'video' | 'document' | 'audio'; link: string; caption?: string; filename?: string; mimeType?: string; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    const r = await sendMediaMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  async sendTemplate(args: { to: string; templateName: string; language: string; params?: string[]; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    const r = await sendTemplateMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      templateName: args.templateName,
      language: args.language,
      params: args.params || [],
      template: args.template as any,
      messageParams: args.messageParams as any,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  async sendInteractiveButtons(args: { to: string; bodyText: string; headerText?: string; footerText?: string; buttons: { id: string; title: string }[]; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    const r = await sendInteractiveButtons({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      bodyText: args.bodyText,
      headerText: args.headerText,
      footerText: args.footerText,
      buttons: args.buttons,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  async sendInteractiveList(args: { to: string; bodyText: string; buttonLabel: string; headerText?: string; footerText?: string; sections: { title: string; rows: { id: string; title: string; description?: string }[] }[]; contextMessageId?: string }): Promise<WhatsAppSendResult> {
    const r = await sendInteractiveList({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      bodyText: args.bodyText,
      buttonLabel: args.buttonLabel,
      headerText: args.headerText,
      footerText: args.footerText,
      sections: args.sections,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: r.messageId }
  }

  async sendReaction(args: { to: string; messageId: string; emoji: string }): Promise<void> {
    await sendReactionMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      messageId: args.messageId,
      emoji: args.emoji,
    })
  }

  async sendTypingIndicator(args: { to: string; messageId?: string }): Promise<void> {
    await sendTypingIndicator({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      messageId: args.messageId,
    })
  }

  async getMediaUrl(args: { mediaId: string }): Promise<WhatsAppMediaInfo> {
    const r = await getMediaUrl({
      mediaId: args.mediaId,
      accessToken: this.accessToken,
    })
    return { url: r.url, mimeType: r.mimeType, fileSize: r.fileSize }
  }

  async getPhoneHealth(args: { phoneNumberId: string }): Promise<unknown> {
    return getPhoneNumberHealth({
      phoneNumberId: args.phoneNumberId,
      accessToken: this.accessToken,
    })
  }
}
