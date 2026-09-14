'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Room, RoomEvent, Track, type RemoteParticipant } from 'livekit-client'
import { LIVEKIT_CONFIG } from '@/lib/livekit-config'
import { createViewerToken } from '@/lib/livekit-token'
import type { HelmetParticipant, GpsTelemetry } from '@/types/monitor'
import { ParticipantVideo } from '@/components/ParticipantVideo'
import { ParticipantMap } from '@/components/ParticipantMap'
import { GlobalAgentsMap } from '@/components/GlobalAgentsMap'
import { SidebarRooms } from '@/components/SidebarRooms'
import { Map, Users } from 'lucide-react'

function PopoutContent() {
  const searchParams = useSearchParams()
  const roomName = searchParams.get('room') || LIVEKIT_CONFIG.defaultRoom
  const agentTarget = searchParams.get('agent') || ''
  const viewParam = searchParams.get('view') || ''
  const isGlobalMapView = viewParam === 'global-map'
  const isAgentsListView = viewParam === 'agents-list'
  const isMultiAgentView = isGlobalMapView || isAgentsListView

  // Para modo agente individual
  const [participant, setParticipant] = useState<HelmetParticipant | null>(null)
  const [filterMode, setFilterMode] = useState<'all' | 'video' | 'map'>('all')

  // Para modo mapa global
  const [allParticipants, setAllParticipants] = useState<HelmetParticipant[]>([])
  const [isConnected, setIsConnected] = useState(false)

  useEffect(() => {
    let lkRoom: Room | null = null

    async function init() {
      try {
        const token = await createViewerToken(roomName)
        lkRoom = new Room({
          adaptiveStream: true,
          dynacast: true,
        })

        const registerParticipant = (rp: RemoteParticipant) => {
          if (rp.identity.startsWith('monitor-pc-')) return
          if (!isMultiAgentView && agentTarget && rp.identity !== agentTarget) return

          const name = rp.identity.replace(/^casco-/, '').replace(/-/g, ' ')
          const initials =
            name
              .split(' ')
              .slice(0, 2)
              .map((s) => s[0]?.toUpperCase() || '')
              .join('') || 'C'

          const videoPub = Array.from(rp.trackPublications.values()).find(
            (p) => p.kind === Track.Kind.Video
          )

          const newP: HelmetParticipant = {
            id: rp.sid || rp.identity,
            identity: rp.identity,
            name,
            initials,
            isLocal: false,
            isSpeaking: false,
            hasVideoTrack: Boolean(videoPub?.track),
            hasAudioTrack: false,
            isCameraOff: !videoPub?.track,
            isAudioMuted: true,
            videoPublication: videoPub,
            routeHistory: [],
            participantInstance: rp,
          }

          if (isMultiAgentView) {
            setAllParticipants((prev) => {
              if (prev.find((p) => p.identity === rp.identity)) return prev
              return [...prev, newP]
            })
          } else {
            setParticipant(newP)
          }
        }

        lkRoom.on(RoomEvent.ParticipantConnected, registerParticipant)

        lkRoom.on(RoomEvent.ParticipantDisconnected, (rp) => {
          if (isMultiAgentView) {
            setAllParticipants((prev) => prev.filter((p) => p.identity !== rp.identity))
          } else if (participant?.identity === rp.identity) {
            setParticipant(null)
          }
        })

        lkRoom.on(RoomEvent.TrackSubscribed, (track, pub, rp) => {
          if (rp.identity.startsWith('monitor-pc-')) return
          if (!isMultiAgentView && agentTarget && rp.identity !== agentTarget) return

          if (track.kind === Track.Kind.Video) {
            if (isMultiAgentView) {
              setAllParticipants((prev) =>
                prev.map((p) =>
                  p.identity === rp.identity
                    ? { ...p, hasVideoTrack: true, isCameraOff: false, videoPublication: pub }
                    : p
                )
              )
            } else {
              setParticipant((prev) =>
                prev
                  ? { ...prev, hasVideoTrack: true, isCameraOff: false, videoPublication: pub }
                  : null
              )
            }
          }
        })

        lkRoom.on(RoomEvent.DataReceived, (payload, rp, _kind, topic) => {
          if (!rp || rp.identity.startsWith('monitor-pc-')) return
          if (!isMultiAgentView && agentTarget && rp.identity !== agentTarget) return

          if (topic === 'location' || topic === 'gps') {
            try {
              const data = JSON.parse(new TextDecoder().decode(payload)) as GpsTelemetry
              if (typeof data.lat === 'number' && typeof data.lng === 'number') {
                registerParticipant(rp as RemoteParticipant)
                const latLng: [number, number] = [data.lat, data.lng]

                if (isMultiAgentView) {
                  setAllParticipants((prev) =>
                    prev.map((p) => {
                      if (p.identity !== rp.identity) return p
                      const hist = [...p.routeHistory, latLng]
                      if (hist.length > 500) hist.shift()
                      return {
                        ...p,
                        gps: data,
                        routeHistory: hist,
                        lastGpsUpdate: Date.now(),
                      }
                    })
                  )
                } else {
                  setParticipant((prev) => {
                    if (!prev) return null
                    const hist = [...prev.routeHistory, latLng]
                    if (hist.length > 500) hist.shift()
                    return {
                      ...prev,
                      gps: data,
                      routeHistory: hist,
                    }
                  })
                }
              }
            } catch (e) {}
          }
        })

        await lkRoom.connect(LIVEKIT_CONFIG.wsUrl, token)
        setIsConnected(true)

        lkRoom.remoteParticipants.forEach(registerParticipant)
      } catch (err) {
        console.error('[Popout] Error:', err)
      }
    }

    init()

    return () => {
      if (lkRoom) {
        try {
          lkRoom.disconnect()
        } catch (e) {}
      }
    }
  }, [roomName, agentTarget, isMultiAgentView])

  // ── Vista 1: Mapa Global en Pantalla Secundaria / Externa ──────────────────
  if (isGlobalMapView) {
    return (
      <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden font-sans">
        <header className="h-11 px-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
            <Map className="size-4 text-blue-400" />
            <span className="text-xs font-bold text-slate-100">
              Mapa Global de Agentes (Monitor Externo)
            </span>
            <span className="text-[10px] text-slate-400">Sala: {roomName}</span>
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            {allParticipants.length} agente(s) conectado(s)
          </div>
        </header>
        <main className="flex-1 min-h-0 relative">
          <GlobalAgentsMap
            participants={allParticipants}
            roomName={roomName}
            className="w-full h-full border-0"
          />
        </main>
      </div>
    )
  }

  // ── Vista 2: Lista de Agentes en Pantalla Secundaria / Externa ─────────────
  if (isAgentsListView) {
    return (
      <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden font-sans">
        <header className="h-11 px-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
            <Users className="size-4 text-blue-400" />
            <span className="text-xs font-bold text-slate-100">
              Panel de Agentes Conectados (Monitor Externo)
            </span>
            <span className="text-[10px] text-slate-400">Sala: {roomName}</span>
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            {allParticipants.length} conectado(s)
          </div>
        </header>
        <main className="flex-1 min-h-0 relative bg-slate-950">
          <SidebarRooms
            connectedRoomNames={[roomName]}
            participants={allParticipants}
            isOpen={true}
            isPolling={false}
            onToggleOpen={() => {}}
            onRefreshRooms={() => {}}
            onFocusParticipant={() => {}}
            className="w-full h-full border-0 shadow-none"
          />
        </main>
      </div>
    )
  }

  // ── Vista 3: Monitor de Agente Individual ──────────────────────────────────
  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Cabecera compacta */}
      <header className="h-12 px-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-bold text-slate-100">
            {participant ? participant.name : agentTarget || 'Monitor Secundario'}
          </span>
          <span className="text-[10px] text-slate-400">({roomName})</span>
        </div>

        {/* Selector de modo */}
        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
          <button
            type="button"
            onClick={() => setFilterMode('all')}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
              filterMode === 'all' ? 'bg-blue-600 text-white' : 'text-slate-400'
            }`}
          >
            Dividido
          </button>
          <button
            type="button"
            onClick={() => setFilterMode('video')}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
              filterMode === 'video' ? 'bg-blue-600 text-white' : 'text-slate-400'
            }`}
          >
            Video
          </button>
          <button
            type="button"
            onClick={() => setFilterMode('map')}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
              filterMode === 'map' ? 'bg-blue-600 text-white' : 'text-slate-400'
            }`}
          >
            Mapa
          </button>
        </div>
      </header>

      {/* Contenido */}
      <main className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden relative">
        {participant ? (
          <>
            {(filterMode === 'all' || filterMode === 'video') && (
              <div
                className={`relative ${
                  filterMode === 'all'
                    ? 'flex-1 md:w-1/2 border-b md:border-b-0 md:border-r border-slate-800'
                    : 'w-full h-full'
                }`}
              >
                <ParticipantVideo participant={participant} isMaximized={true} />
              </div>
            )}
            {(filterMode === 'all' || filterMode === 'map') && (
              <div
                className={`relative ${
                  filterMode === 'all' ? 'flex-1 md:w-1/2' : 'w-full h-full'
                }`}
              >
                <ParticipantMap participant={participant} />
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">
            {isConnected ? 'Esperando señal del casco...' : 'Conectando monitor secundario...'}
          </div>
        )}
      </main>
    </div>
  )
}

export default function PopoutPage() {
  return (
    <Suspense fallback={<div className="bg-slate-950 h-screen w-screen" />}>
      <PopoutContent />
    </Suspense>
  )
}
