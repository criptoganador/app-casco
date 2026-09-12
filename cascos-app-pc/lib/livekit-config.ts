/**
 * Configuración de conexión con LiveKit Cloud SFU
 * Compatible con la transmisión del casco móvil y el monitor de PC.
 */

export const LIVEKIT_CONFIG = {
  // Servidor WebSocket SFU
  wsUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL || 'wss://asicme-casco-xlxbe39o.livekit.cloud',
  // Endpoint API REST / Twirp para consulta de salas
  apiUrl: process.env.NEXT_PUBLIC_LIVEKIT_API || 'https://asicme-casco-xlxbe39o.livekit.cloud',
  // Credenciales API
  apiKey: process.env.NEXT_PUBLIC_LIVEKIT_API_KEY || 'APIutSnBDwPrHSM',
  apiSecret: process.env.LIVEKIT_API_SECRET || 'DYIeeEd4f2ljsCgOQN2wb7ypHErawhAmeEBm0gVq5TmD',
  // Sala predeterminada si no se especifica ninguna
  defaultRoom: 'jhoan',
  // Intervalo de sondeo para salas activas (ms)
  pollIntervalMs: 5000,
} as const
