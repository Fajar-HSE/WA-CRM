import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { processWahaInbound } from '@/lib/whatsapp/waha-inbound'

export const maxDuration = 60

export async function POST(request: Request) {
  const rawBody = await request.text()
  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Secret verification (fail-closed when configured).
  const secret = process.env.WAHA_WEBHOOK_SECRET
  if (secret) {
    const presented = request.headers.get('x-waha-webhook-secret') || request.headers.get('x-webhook-secret')
    if (presented !== secret) {
      console.warn('[waha-webhook] rejected: bad secret')
      return NextResponse.json({ error: 'Invalid secret' }, { status: 401 })
    }
  } else {
    console.warn('[waha-webhook] WAHA_WEBHOOK_SECRET not set - accepting without verification (dev only)')
  }

  const event = body?.event
  const sessionName = body?.session
  if (!sessionName) {
    return NextResponse.json({ error: 'Missing session' }, { status: 400 })
  }

  // Only handle inbound messages here; acks/statuses can be added later.
  if (event !== 'message' && event !== 'message.any') {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const payload = body?.payload
  if (!payload || payload.fromMe) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  try {
    await processWahaInbound({ sessionName, payload })
  } catch (err) {
    console.error('[waha-webhook] processing failed:', err)
    // Ack 200 anyway to avoid WAHA retries storm; log for ops.
  }

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
