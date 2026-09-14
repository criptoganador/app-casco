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

export async function GET() {
  try {
    const apiKey = process.env.NEXT_PUBLIC_LIVEKIT_API_KEY || LIVEKIT_CONFIG.apiKey
    const apiSecret = process.env.LIVEKIT_API_SECRET || LIVEKIT_CONFIG.apiSecret

    if (!apiSecret) {
      return NextResponse.json(
        { error: 'LIVEKIT_API_SECRET no está configurado.' },
        { status: 500 }
      )
    }

    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      {
        iss: apiKey,
        sub: 'monitor-admin',
        nbf: now - 5,
        exp: now + 300,
        video: { roomList: true, roomAdmin: true, roomCreate: true },
      },
      apiSecret
    )

    const res = await fetch(`${LIVEKIT_CONFIG.apiUrl}/twirp/livekit.RoomService/ListRooms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      cache: 'no-store',
    })

    if (!res.ok) {
      const errText = await res.text()
      return NextResponse.json(
        { error: `Error Twirp ListRooms (HTTP ${res.status})`, details: errText },
        { status: res.status }
      )
    }

    const data = await res.json()
    return NextResponse.json(data)
  } catch (err: any) {
    console.error('[API /api/livekit/rooms GET] Error:', err)
    return NextResponse.json({ error: err.message || 'Error consultando salas' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const room = searchParams.get('room')
    if (!room) {
      return NextResponse.json({ error: 'Parámetro room requerido.' }, { status: 400 })
    }

    const apiKey = process.env.NEXT_PUBLIC_LIVEKIT_API_KEY || LIVEKIT_CONFIG.apiKey
    const apiSecret = process.env.LIVEKIT_API_SECRET || LIVEKIT_CONFIG.apiSecret

    if (!apiSecret) {
      return NextResponse.json(
        { error: 'LIVEKIT_API_SECRET no está configurado.' },
        { status: 500 }
      )
    }

    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      {
        iss: apiKey,
        sub: 'monitor-admin',
        nbf: now - 5,
        exp: now + 300,
        video: { roomList: true, roomAdmin: true, roomCreate: true },
      },
      apiSecret
    )

    const res = await fetch(`${LIVEKIT_CONFIG.apiUrl}/twirp/livekit.RoomService/DeleteRoom`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ room }),
    })

    if (!res.ok) {
      return NextResponse.json({ error: `Error DeleteRoom (HTTP ${res.status})` }, { status: res.status })
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[API /api/livekit/rooms DELETE] Error:', err)
    return NextResponse.json({ error: err.message || 'Error eliminando sala' }, { status: 500 })
  }
}
