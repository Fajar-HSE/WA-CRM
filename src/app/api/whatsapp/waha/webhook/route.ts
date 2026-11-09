import { NextResponse } from 'next/server'
import { processWahaInbound, processWahaOutgoing } from '@/lib/whatsapp/waha-inbound'
import { processWahaAck } from '@/lib/whatsapp/waha-ack'
import { isNonCustomerChat } from '@/lib/whatsapp/waha-ids'
import {
  WAHA_WEBHOOK_SECRET_HEADER,
  wahaSecretMatches,
} from '@/lib/whatsapp/waha-config'

export const maxDuration = 60

interface WahaWebhookBody {
  event?: string
  session?: string
  payload?: { fromMe?: boolean; from?: string | null } & Record<string, unknown>
}

export async function POST(request: Request) {
  // Fail closed. A missing secret used to mean "accept everything" with a
  // console warning, which left the endpoint open to forged inbound
  // messages (and, through them, to the automations and AI auto-reply
  // they trigger).
  const secret = process.env.WAHA_WEBHOOK_SECRET?.trim()
  if (!secret) {
    console.error('[waha-webhook] WAHA_WEBHOOK_SECRET is not set - rejecting all deliveries')
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
  }

  const presented =
    request.headers.get(WAHA_WEBHOOK_SECRET_HEADER) ||
    request.headers.get('x-waha-webhook-secret')
  if (!wahaSecretMatches(presented, secret)) {
    console.warn('[waha-webhook] rejected: bad secret')
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 })
  }

  let body: WahaWebhookBody
  try {
    body = JSON.parse(await request.text()) as WahaWebhookBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const event = body?.event
  const sessionName = body?.session
  if (!sessionName) {
    return NextResponse.json({ error: 'Missing session' }, { status: 400 })
  }

  // Delivery/read receipts for messages we sent.
  if (event === 'message.ack') {
    try {
      await processWahaAck({ sessionName, payload: body.payload ?? {} })
    } catch (err) {
      console.error('[waha-webhook] ack processing failed:', err)
    }
    return NextResponse.json({ status: 'received' }, { status: 200 })
  }

  // Inbound messages.
  if (event !== 'message' && event !== 'message.any') {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const payload = body.payload
  if (!payload) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  // Typed on the phone itself (or echoed back after a CRM send). Only
  // `message.any` carries these; record them so the chat counts as answered.
  if (payload.fromMe) {
    if (event === 'message.any') {
      try {
        await processWahaOutgoing({ sessionName, payload })
      } catch (err) {
        console.error('[waha-webhook] outgoing processing failed:', err)
      }
      return NextResponse.json({ status: 'received' }, { status: 200 })
    }
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  // WhatsApp Status updates, channels and groups are not customer chats.
  if (isNonCustomerChat(payload.from)) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  try {
    await processWahaInbound({ sessionName, payload })
  } catch (err) {
    console.error('[waha-webhook] processing failed:', err)
    // Ack 200 anyway to avoid a WAHA retry storm; the error is logged.
  }

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
