import { LIVEKIT_CONFIG } from './livekit-config'

/**
 * Generador de tokens JWT client-side usando Web Crypto API (HMAC-SHA256).
 * Idéntico a la implementación de monitor_livekit.html.
 */
export async function buildLiveKitToken(claims: Record<string, unknown>, secretKey?: string): Promise<string> {
  const secret = secretKey || LIVEKIT_CONFIG.apiSecret

  const b64 = (str: string) =>
    btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

  const b64arr = (buf: ArrayBuffer) => {
    let s = ''
    new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)))
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64(JSON.stringify(claims))
  const msg = `${header}.${payload}`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
  return `${msg}.${b64arr(sig)}`
}

/**
 * Token para consultar lista de salas activas vía API Twirp.
 */
export async function createAdminToken(): Promise<string> {
  try {
    const res = await fetch('/api/livekit/token?type=admin')
    if (res.ok) {
      const data = await res.json()
      if (data.token) return data.token
    }
  } catch (err) {
    console.warn('[Token] Error obteniendo admin token del servidor, usando fallback local:', err)
  }

  const now = Math.floor(Date.now() / 1000)
  return buildLiveKitToken({
    iss: LIVEKIT_CONFIG.apiKey,
    sub: 'monitor-admin',
    nbf: now - 5,
    exp: now + 300,
    video: { roomList: true, roomAdmin: true, roomCreate: true },
  })
}

/**
 * Token de espectador para unirse a una sala y publicar micrófono.
 */
export async function createViewerToken(roomName: string): Promise<string> {
  try {
    const res = await fetch(`/api/livekit/token?room=${encodeURIComponent(roomName)}&type=viewer`)
    if (res.ok) {
      const data = await res.json()
      if (data.token) return data.token
    }
  } catch (err) {
    console.warn('[Token] Error obteniendo viewer token del servidor, usando fallback local:', err)
  }

  const now = Math.floor(Date.now() / 1000)
  return buildLiveKitToken({
    iss: LIVEKIT_CONFIG.apiKey,
    sub: `monitor-pc-${Math.random().toString(36).slice(2, 7)}`,
    nbf: now - 5,
    exp: now + 86400,
    video: {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    },
  })
}

/**
 * Elimina y purga una sala de LiveKit Cloud de forma totalmente automática vía Twirp API.
 * Desconecta participantes colgados y libera los cupos de LiveKit al instante.
 */
export async function deleteLiveKitRoom(roomName: string): Promise<boolean> {
  const cleanRoom = (roomName || '').trim()
  if (!cleanRoom) return false

  try {
    const res = await fetch(`/api/livekit/rooms?room=${encodeURIComponent(cleanRoom)}`, {
      method: 'DELETE',
    })

    if (res.ok) {
      console.log(`[AutoDelete] 🧹 Sala "${cleanRoom}" eliminada de LiveKit Cloud automáticamente.`)
      return true
    } else {
      console.warn(`[AutoDelete] Aviso al eliminar sala "${cleanRoom}": HTTP ${res.status}`)
      return false
    }
  } catch (err) {
    console.warn(`[AutoDelete] Error eliminando sala "${cleanRoom}":`, err)
    return false
  }
}
