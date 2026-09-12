/**
 * Configuración de conexión con LiveKit Cloud SFU
 * Compatible con la transmisión del casco móvil y el monitor de PC.
 *
 * Variables de entorno requeridas en producción (Render):
 *   NEXT_PUBLIC_LIVEKIT_URL       wss://tu-proyecto.livekit.cloud
 *   NEXT_PUBLIC_LIVEKIT_API       https://tu-proyecto.livekit.cloud
 *   NEXT_PUBLIC_LIVEKIT_API_KEY   APIxxxxxxxxxxxxxxx
 *   LIVEKIT_API_SECRET            xxxxxxxxxxxxxxxxxxxxxx  (server-only)
 */

export const LIVEKIT_CONFIG = {
  // Servidor WebSocket SFU
  wsUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL || 'wss://asicme-casco-xlxbe39o.livekit.cloud',
  // Endpoint API REST / Twirp para consulta de salas
  apiUrl: process.env.NEXT_PUBLIC_LIVEKIT_API || 'https://asicme-casco-xlxbe39o.livekit.cloud',
  // Credenciales API
  apiKey: process.env.NEXT_PUBLIC_LIVEKIT_API_KEY || 'APIutSnBDwPrHSM',
  // ⚠️  LIVEKIT_API_SECRET no lleva NEXT_PUBLIC_ para que no se exponga en el bundle del cliente
  apiSecret: process.env.LIVEKIT_API_SECRET || '',
  // Sala predeterminada si no se especifica ninguna
  defaultRoom: process.env.NEXT_PUBLIC_DEFAULT_ROOM || 'jhoan',
  // Intervalo de sondeo para salas activas (ms)
  pollIntervalMs: 5000,
} as const
