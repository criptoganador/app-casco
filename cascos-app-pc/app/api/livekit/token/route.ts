import { NextRequest, NextResponse } from 'next/server'
import { LIVEKIT_CONFIG } from '@/lib/livekit-config'

function base64Url(str: string) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function signJwt(claims: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify(claims))
  const msg = `${header}.${payload}`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
  const sig = Buffer.from(sigBuffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  return `${msg}.${sig}`
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') || 'viewer'
  const room = searchParams.get('room') || LIVEKIT_CONFIG.defaultRoom

  const apiKey = process.env.NEXT_PUBLIC_LIVEKIT_API_KEY || LIVEKIT_CONFIG.apiKey
  const apiSecret = process.env.LIVEKIT_API_SECRET || LIVEKIT_CONFIG.apiSecret

  if (!apiSecret) {
    return NextResponse.json(
      { error: 'LIVEKIT_API_SECRET no está configurado en las variables de entorno de Render.' },
      { status: 500 }
    )
  }

  const now = Math.floor(Date.now() / 1000)

  if (type === 'admin') {
    const claims = {
      iss: apiKey,
      sub: 'monitor-admin',
      nbf: now - 5,
      exp: now + 300,
      video: { roomList: true, roomAdmin: true, roomCreate: true },
    }
    const token = await signJwt(claims, apiSecret)
    return NextResponse.json({ token })
  }

  const claims = {
    iss: apiKey,
    sub: `monitor-pc-${Math.random().toString(36).slice(2, 7)}`,
    nbf: now - 5,
    exp: now + 86400,
    video: {
      room: room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    },
  }
  const token = await signJwt(claims, apiSecret)
  return NextResponse.json({ token })
}
