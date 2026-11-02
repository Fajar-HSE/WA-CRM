import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { WahaWhatsAppProvider } from '@/lib/whatsapp/providers/waha'

function providerFor(sessionName: string) {
  return new WahaWhatsAppProvider({
    sessionName,
    baseUrl: process.env.WAHA_BASE_URL,
    apiKey: process.env.WAHA_API_KEY,
  })
}

export async function GET(request: Request) {
  try {
    await requireRole('admin')
    const { searchParams } = new URL(request.url)
    const name = searchParams.get('name') || ''
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    const p = providerFor(name)
    const status = await p.getSessionStatus!(name)
    const qr = status === 'SCAN_QR_CODE' ? await p.getQrCode!(name) : null
    return NextResponse.json({ name, status, qr })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    await requireRole('admin')
    const body = await request.json().catch(() => ({}))
    const name = body?.name || body?.sessionName
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    const p = providerFor(name)
    await p.startSession!(name)
    const status = await p.getSessionStatus!(name)
    const qr = await p.getQrCode!(name)
    return NextResponse.json({ name, status, qr })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    await requireRole('admin')
    const { searchParams } = new URL(request.url)
    const name = searchParams.get('name') || ''
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    const p = providerFor(name)
    await p.logoutSession!(name)
    return NextResponse.json({ name, status: 'logged_out' })
  } catch (err) {
    return toErrorResponse(err)
  }
}
