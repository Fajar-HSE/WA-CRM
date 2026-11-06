// ============================================================
// Inbound media from WAHA.
//
// WAHA hands the CRM a URL for each received photo / voice note /
// document. That URL points at WAHA's own file store: it needs WAHA's API
// key, and it is often a private address (http://waha:3000/...) that a
// browser cannot reach — or an http:// address the https site would block.
// Storing it as-is is why inbound images showed as a broken picture.
//
// Instead the server downloads the file (with the key) and copies it into
// the `chat-media` bucket, the same place outbound media and Meta's inbound
// media live, and stores that durable public URL.
// ============================================================

import { createHash } from 'node:crypto'
import {
  mirrorInboundMedia,
  type MirrorStorage,
} from '@/lib/whatsapp/mirror-inbound-media'

/** Give up on a download after this long so a slow WAHA cannot stall the webhook. */
const DOWNLOAD_TIMEOUT_MS = 15_000

export interface WahaMediaInfo {
  url?: string | null
  mimetype?: string | null
  filename?: string | null
}

/**
 * The URL WAHA reports uses WAHA's own idea of its address, which the app
 * may not be able to reach (and which must not be trusted as a fetch target
 * anyway). Keep only the path and query and re-root it on `WAHA_BASE_URL`.
 */
export function rewriteWahaMediaUrl(
  rawUrl: string,
  baseUrl: string | undefined,
): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, '')
  if (!base) return null
  try {
    const parsed = new URL(rawUrl, base)
    if (!parsed.pathname.startsWith('/api/')) return null
    return `${base}${parsed.pathname}${parsed.search}`
  } catch {
    return null
  }
}

/**
 * Stable numeric id for a message, so a redelivered webhook rewrites the
 * same bucket object instead of adding a copy. 19 digits, like a Meta
 * media id, which is what the shared naming helpers expect.
 */
export function mediaIdForMessage(messageId: string): string {
  const hex = createHash('sha256').update(messageId).digest('hex').slice(0, 16)
  return BigInt(`0x${hex}`).toString().padStart(19, '0').slice(0, 19)
}

/** `download` for mirrorInboundMedia: Meta's slot takes a bearer token, WAHA wants X-Api-Key. */
async function downloadFromWaha(args: {
  downloadUrl: string
  accessToken: string
}): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(args.downloadUrl, {
      headers: { 'X-Api-Key': args.accessToken },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`WAHA media download failed: ${res.status}`)
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Copy one inbound WAHA attachment into storage.
 *
 * @returns the durable public URL, or `null` when WAHA sent no file (media
 *          download is off or the edition does not include it), the file
 *          could not be fetched, or storage refused it. Never throws: a
 *          webhook that fails would be retried and re-run every automation.
 */
export async function mirrorWahaMedia(args: {
  storage: MirrorStorage
  accountId: string
  messageId: string
  media: WahaMediaInfo | null | undefined
  timestamp?: number | null
  baseUrl?: string
  apiKey?: string
}): Promise<string | null> {
  const {
    storage,
    accountId,
    messageId,
    media,
    timestamp,
    baseUrl = process.env.WAHA_BASE_URL,
    apiKey = process.env.WAHA_API_KEY,
  } = args

  if (!media?.url) {
    console.warn(
      '[waha-media] message has media but WAHA sent no file URL. Media download may be switched off in WAHA, or this edition does not include it.',
    )
    return null
  }
  const downloadUrl = rewriteWahaMediaUrl(media.url, baseUrl)
  if (!downloadUrl || !apiKey) {
    console.warn('[waha-media] cannot download: WAHA_BASE_URL / WAHA_API_KEY missing or the media URL is not a WAHA path')
    return null
  }

  try {
    return await mirrorInboundMedia({
      storage,
      accountId,
      mediaId: mediaIdForMessage(messageId),
      downloadUrl,
      accessToken: apiKey,
      mimeType: media.mimetype,
      fileName: media.filename,
      messageTimestamp: timestamp ?? null,
      download: downloadFromWaha,
    })
  } catch (err) {
    console.warn('[waha-media] mirror failed:', err instanceof Error ? err.message : err)
    return null
  }
}
