'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type TrackPublication,
} from 'livekit-client'
import { LIVEKIT_CONFIG } from '@/lib/livekit-config'
import { createAdminToken, createViewerToken } from '@/lib/livekit-token'
import type {
  HelmetParticipant,
  WindowState,
  RoomSummary,
  ViewFilterMode,
  GpsTelemetry,
} from '@/types/monitor'
import { RoomHeader } from './RoomHeader'
import { SidebarRooms } from './SidebarRooms'
import { ParticipantWindow } from './ParticipantWindow'
import { GlobalAgentsMap } from './GlobalAgentsMap'
import { Users, Radio, ShieldAlert } from 'lucide-react'

export function VideoRoomWorkspace() {
  // Estado de LiveKit Room
  const [currentRoomName, setCurrentRoomName] = useState<string>(LIVEKIT_CONFIG.defaultRoom)
  const [room, setRoom] = useState<Room | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)

  // Salas activas detectadas por Twirp API
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [isPollingRooms, setIsPollingRooms] = useState(false)

  // Participantes conectados en la sala actual
  const [participants, setParticipants] = useState<HelmetParticipant[]>([])

  // Estado de las ventanas (posiciones, dimensiones, flotantes, z-index)
  const [windows, setWindows] = useState<Record<string, WindowState>>({})
  const [highestZ, setHighestZ] = useState(10)

  // Modos de visualización y barra lateral
  const [isAutoArrange, setIsAutoArrange] = useState(true)
  const [filterMode, setFilterMode] = useState<ViewFilterMode>('all')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Control de audio
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(true)
  const audioElementsRef = useRef<HTMLAudioElement[]>([])
  const pendingAudioRef = useRef<HTMLAudioElement[]>([])

  // ─────────────────────────────────────────────────────────
  // GESTIÓN DE PARTICIPANTES Y VENTANAS
  // ─────────────────────────────────────────────────────────
  const attachRemoteAudio = useCallback((track: any, participantIdentity: string) => {
    // Ignorar pistas de otros monitores PC para evitar retroalimentación
    if (participantIdentity.startsWith('monitor-pc-')) return

    try {
      const audioEl = track.attach() as HTMLAudioElement
      audioEl.style.display = 'none'
      document.body.appendChild(audioEl)
      audioElementsRef.current.push(audioEl)

      audioEl
        .play()
        .then(() => {
          setIsAudioUnlocked(true)
        })
        .catch(() => {
          console.warn('[Audio] Autoplay bloqueado por el navegador. Requiere interacción.')
          setIsAudioUnlocked(false)
          pendingAudioRef.current.push(audioEl)
        })
    } catch (err) {
      console.error('[Audio] Error al reproducir pista de audio remota:', err)
    }
  }, [])

  const handleParticipantJoined = useCallback(
    (rp: RemoteParticipant) => {
      if (!rp || !rp.identity || rp.identity.startsWith('monitor-pc-')) return
      const identity = rp.identity
      const name = identity.replace(/^casco-/, '').replace(/-/g, ' ')
      const initials =
        name
          .split(' ')
          .slice(0, 2)
          .map((s) => s[0]?.toUpperCase() || '')
          .join('') || 'C'

      // Detectar publicaciones activas y auto-suscribirse
      let videoPub: TrackPublication | undefined
      let audioPub: TrackPublication | undefined

      rp.trackPublications.forEach((pub) => {
        if (pub.kind === Track.Kind.Video) {
          videoPub = pub
          if (!pub.isSubscribed) {
            pub.setSubscribed(true)
          }
        } else if (pub.kind === Track.Kind.Audio) {
          audioPub = pub
          if (!pub.isSubscribed) {
            pub.setSubscribed(true)
          }
          if (pub.track) {
            attachRemoteAudio(pub.track, identity)
          }
        }
      })

      setParticipants((prev) => {
        const existing = prev.find((p) => p.identity === identity)
        if (existing) {
          return prev.map((p) =>
            p.identity === identity
              ? {
                  ...p,
                  hasVideoTrack: Boolean(videoPub || p.hasVideoTrack),
                  hasAudioTrack: Boolean(audioPub || p.hasAudioTrack),
                  isCameraOff: false,
                  videoPublication: videoPub || p.videoPublication,
                  audioPublication: audioPub || p.audioPublication,
                  participantInstance: rp,
                }
              : p
          )
        }

        const newParticipant: HelmetParticipant = {
          id: rp.sid || identity,
          identity,
          name,
          initials,
          isLocal: false,
          isSpeaking: false,
          hasVideoTrack: Boolean(videoPub),
          hasAudioTrack: Boolean(audioPub),
          isCameraOff: false,
          isAudioMuted: false,
          videoPublication: videoPub,
          audioPublication: audioPub,
          routeHistory: [],
          participantInstance: rp,
        }
        return [...prev, newParticipant]
      })

      // Inicializar estado de ventana de manera inmediata
      setWindows((prev) => {
        if (prev[identity]) return prev
        const count = Object.keys(prev).length
        return {
          ...prev,
          [identity]: {
            id: identity,
            x: 40 + (count % 4) * 35,
            y: 90 + Math.floor(count / 4) * 35,
            width: 580,
            height: 380,
            floating: false,
            minimized: false,
            maximized: false,
            z: count + 1,
          },
        }
      })
    },
    [attachRemoteAudio]
  )

  const handleParticipantLeft = useCallback((identity: string) => {
    setParticipants((prev) => prev.filter((p) => p.identity !== identity))
    setWindows((prev) => {
      const next = { ...prev }
      delete next[identity]
      return next
    })
  }, [])

  const updateParticipant = useCallback((identity: string, patch: Partial<HelmetParticipant>) => {
    setParticipants((prev) =>
      prev.map((p) => (p.identity === identity ? { ...p, ...patch } : p))
    )
  }, [])

  const handleGpsReceived = useCallback((identity: string, data: GpsTelemetry) => {
    setParticipants((prev) =>
      prev.map((p) => {
        if (p.identity !== identity) return p
        const latLng: [number, number] = [data.lat, data.lng]
        const history = [...p.routeHistory, latLng]
        if (history.length > 500) history.shift()
        return {
          ...p,
          gps: data,
          routeHistory: history,
          lastGpsUpdate: Date.now(),
        }
      })
    )
  }, [])

  // ─────────────────────────────────────────────────────────
  // CONEXIÓN A SALA LIVEKIT
  // ─────────────────────────────────────────────────────────
  const connectToRoom = useCallback(
    async (roomToJoin: string) => {
      const cleanRoom = roomToJoin.trim()
      if (!cleanRoom) return

      if (room) {
        try {
          await room.disconnect()
        } catch (e) {}
      }

      audioElementsRef.current.forEach((el) => {
        try {
          el.pause()
          el.remove()
        } catch (e) {}
      })
      audioElementsRef.current = []
      pendingAudioRef.current = []

      setIsConnecting(true)
      setIsConnected(false)
      setConnectionError(null)
      setCurrentRoomName(cleanRoom)

      try {
        const token = await createViewerToken(cleanRoom)
        const lkRoom = new Room({
          adaptiveStream: true,
          dynacast: true,
        })

        // 1. Participante conectado
        lkRoom.on(RoomEvent.ParticipantConnected, (remoteParticipant: RemoteParticipant) => {
          if (remoteParticipant.identity.startsWith('monitor-pc-')) return
          handleParticipantJoined(remoteParticipant)
        })

        // 2. Participante desconectado
        lkRoom.on(RoomEvent.ParticipantDisconnected, (remoteParticipant: RemoteParticipant) => {
          handleParticipantLeft(remoteParticipant.identity)
        })

        // 3. Pista publicada (auto-suscribirse de inmediato e iniciar video/audio)
        lkRoom.on(RoomEvent.TrackPublished, (publication, participant) => {
          if (participant.identity.startsWith('monitor-pc-')) return
          publication.setSubscribed(true)

          handleParticipantJoined(participant as RemoteParticipant)

          if (publication.kind === Track.Kind.Video) {
            updateParticipant(participant.identity, {
              hasVideoTrack: true,
              isCameraOff: false,
              videoPublication: publication,
            })
          } else if (publication.kind === Track.Kind.Audio) {
            updateParticipant(participant.identity, {
              hasAudioTrack: true,
              isAudioMuted: false,
              audioPublication: publication,
            })
          }
        })

        // 4. Pista suscrita (Video o Audio) - Iniciar llamada / stream al instante
        lkRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (participant.identity.startsWith('monitor-pc-')) return

          handleParticipantJoined(participant as RemoteParticipant)

          if (track.kind === Track.Kind.Video || (track.kind as string) === 'video') {
            updateParticipant(participant.identity, {
              hasVideoTrack: true,
              isCameraOff: false,
              videoPublication: publication,
            })
          } else if (track.kind === Track.Kind.Audio || (track.kind as string) === 'audio') {
            attachRemoteAudio(track, participant.identity)
            updateParticipant(participant.identity, {
              hasAudioTrack: true,
              isAudioMuted: false,
              audioPublication: publication,
            })
          }
        })

        // 5. Pista desuscrita
        lkRoom.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
          if (track.kind === Track.Kind.Video || (track.kind as string) === 'video') {
            updateParticipant(participant.identity, {
              hasVideoTrack: false,
              isCameraOff: true,
            })
          }
        })

        // 6. Telemetría GPS vía WebRTC DataChannel
        lkRoom.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
          if (topic === 'location' || topic === 'gps') {
            try {
              const text = new TextDecoder().decode(payload)
              const data = JSON.parse(text)
              if (participant && typeof data.lat === 'number' && typeof data.lng === 'number') {
                handleParticipantJoined(participant as RemoteParticipant)
                handleGpsReceived(participant.identity, data)
              }
            } catch (err) {
              console.warn('[DataChannel] Error procesando telemetría GPS:', err)
            }
          }
        })

        // 7. Indicadores de oradores activos
        lkRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const speakingIds = new Set(speakers.map((s) => s.identity))
          setParticipants((prev) =>
            prev.map((p) => ({
              ...p,
              isSpeaking: speakingIds.has(p.identity),
            }))
          )
        })

        // 8. Desconexión de la sala
        lkRoom.on(RoomEvent.Disconnected, () => {
          setIsConnected(false)
          setIsConnecting(false)
          setParticipants([])
        })

        // Conectar al servidor LiveKit SFU con autoSubscribe activado
        await lkRoom.connect(LIVEKIT_CONFIG.wsUrl, token, {
          autoSubscribe: true,
        })

        setRoom(lkRoom)
        setIsConnected(true)
        setIsConnecting(false)

        // Registrar participantes remotos existentes y suscribir pistas
        lkRoom.remoteParticipants.forEach((remoteParticipant) => {
          if (!remoteParticipant.identity.startsWith('monitor-pc-')) {
            handleParticipantJoined(remoteParticipant)
            remoteParticipant.trackPublications.forEach((pub) => {
              if (!pub.isSubscribed) {
                pub.setSubscribed(true)
              }
            })
          }
        })
      } catch (err: any) {
        console.error('[LiveKit] Error de conexión:', err)
        setIsConnecting(false)
        setIsConnected(false)
        setConnectionError(err.message || 'Error conectando a LiveKit Cloud')
      }
    },
    [room, handleParticipantJoined, handleParticipantLeft, updateParticipant, handleGpsReceived, attachRemoteAudio]
  )

  // ─────────────────────────────────────────────────────────
  // CONSULTA DE SALAS ACTIVAS (API REST TWIRP) Y AUTO-CONEXIÓN
  // ─────────────────────────────────────────────────────────
  const fetchActiveRooms = useCallback(async () => {
    try {
      setIsPollingRooms(true)
      const token = await createAdminToken()
      const res = await fetch(`${LIVEKIT_CONFIG.apiUrl}/twirp/livekit.RoomService/ListRooms`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })

      if (res.ok) {
        const data = await res.json()
        const rawRooms = data.rooms || []
        const formatted: RoomSummary[] = rawRooms.map((r: any) => ({
          name: (r.name || '').trim(),
          numParticipants: r.num_participants ?? r.numParticipants ?? 0,
          numPublishers: r.num_publishers ?? r.numPublishers ?? 0,
          isLive: (r.num_participants ?? r.numParticipants ?? 0) > 0,
        }))
        setRooms(formatted)

        // AUTO-CONEXIÓN DINÁMICA:
        // Si detectamos una sala activa con participantes/cámaras y aún no tenemos participantes:
        const liveRoomWithAgents = formatted.find(
          (r) => r.isLive && (r.numPublishers > 0 || r.numParticipants > 0)
        )
        if (liveRoomWithAgents) {
          if (currentRoomName !== liveRoomWithAgents.name && participants.length === 0) {
            console.log(`[AutoConnect] Agente detectado en sala "${liveRoomWithAgents.name}". Conectando automáticamente...`)
            connectToRoom(liveRoomWithAgents.name)
          }
        }
      }
    } catch (err) {
      console.warn('[Twirp] Error consultando lista de salas LiveKit:', err)
    } finally {
      setIsPollingRooms(false)
    }
  }, [currentRoomName, participants.length, connectToRoom])

  // Iniciar conexión y sondeo
  useEffect(() => {
    connectToRoom(LIVEKIT_CONFIG.defaultRoom)
    fetchActiveRooms()
    const interval = setInterval(fetchActiveRooms, LIVEKIT_CONFIG.pollIntervalMs)
    return () => {
      clearInterval(interval)
      if (room) {
        try {
          room.disconnect()
        } catch (e) {}
      }
    }
  }, [])

  const unlockAudioManually = useCallback(() => {
    setIsAudioUnlocked(true)
    pendingAudioRef.current.forEach((el) => {
      el.muted = false
      el.play().catch(() => {})
    })
    pendingAudioRef.current = []
  }, [])

  // Auto-desbloquear audio en cuanto haya el menor gesto en la página
  useEffect(() => {
    const handleUserGesture = () => {
      if (pendingAudioRef.current.length > 0) {
        unlockAudioManually()
      }
    }
    window.addEventListener('pointerdown', handleUserGesture)
    window.addEventListener('keydown', handleUserGesture)
    window.addEventListener('mousemove', handleUserGesture, { once: true })
    return () => {
      window.removeEventListener('pointerdown', handleUserGesture)
      window.removeEventListener('keydown', handleUserGesture)
      window.removeEventListener('mousemove', handleUserGesture)
    }
  }, [unlockAudioManually])

  const updateWindowState = (identity: string, patch: Partial<WindowState>) => {
    setWindows((prev) => ({
      ...prev,
      [identity]: {
        ...prev[identity],
        ...patch,
      },
    }))
  }

  const bringToFront = (identity: string) => {
    const nextZ = highestZ + 1
    setHighestZ(nextZ)
    updateWindowState(identity, { z: nextZ })
  }

  // Soporte Multi-monitor (Popout window)
  const openPopoutWindow = (identity: string) => {
    const popoutUrl = `/popout?room=${encodeURIComponent(currentRoomName)}&agent=${encodeURIComponent(identity)}`
    const popoutWin = window.open(
      popoutUrl,
      `Monitor_${identity}`,
      'width=800,height=600,menubar=no,toolbar=no,location=no,status=no'
    )
    if (popoutWin) {
      popoutWin.focus()
    } else {
      alert('El navegador bloqueó la ventana emergente. Habilita ventanas emergentes para este sitio.')
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 text-slate-900 font-sans">
      {/* Panel Lateral de Agentes Conectados */}
      <SidebarRooms
        currentRoomName={currentRoomName}
        participants={participants}
        isOpen={sidebarOpen}
        isPolling={isPollingRooms}
        onToggleOpen={() => setSidebarOpen(!sidebarOpen)}
        onRefreshRooms={fetchActiveRooms}
        onFocusParticipant={bringToFront}
      />

      {/* Contenedor Principal */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-slate-50 relative">
        {/* Cabecera Superior */}
        <RoomHeader
          roomName={currentRoomName}
          room={room}
          isConnected={isConnected}
          isConnecting={isConnecting}
          participantsCount={participants.length}
          isAutoArrange={isAutoArrange}
          filterMode={filterMode}
          isAudioUnlocked={isAudioUnlocked}
          onToggleAutoArrange={() => setIsAutoArrange(!isAutoArrange)}
          onChangeFilter={setFilterMode}
          onDisconnect={() => room?.disconnect()}
          onUnlockAudio={unlockAudioManually}
        />

        {/* Contenedor Horizontal: Área de Trabajo + Mapa Global de Sala */}
        <div className="flex-1 min-h-0 flex overflow-hidden relative">
          {/* Área de Escritorio de Monitoreo */}
          <main className="flex-1 min-h-0 p-4 overflow-y-auto overflow-x-hidden">
            {connectionError && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
                <ShieldAlert className="size-4 shrink-0" />
                <span>{connectionError}</span>
              </div>
            )}

            {/* Estado vacío: Sin cascos conectados */}
            {participants.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center select-none">
                <div className="size-16 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mb-3.5 shadow-xl">
                  <Radio className="size-7 animate-pulse" />
                </div>
                <h2 className="text-sm font-bold text-slate-100 mb-1">
                  Esperando conexión de cascos inteligentes...
                </h2>
                <p className="text-xs text-slate-400 max-w-sm mb-4 leading-relaxed">
                  Tan pronto como el casco inicie la transmisión desde la aplicación móvil, su video y
                  mapa GPS aparecerán aquí automáticamente.
                </p>
                <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                  <span className="size-2 rounded-full bg-emerald-400 animate-ping" />
                  <span>Escuchando sala: {currentRoomName}</span>
                </div>
              </div>
            ) : (
              /* Cuadrícula estilo YouTube — tarjetas de tamaño fijo con scroll */
              <div
                className={
                  isAutoArrange
                    ? `grid gap-4 content-start ${
                        participants.length === 1
                          ? 'grid-cols-1 max-w-4xl mx-auto'
                          : participants.length === 2
                          ? 'grid-cols-1 lg:grid-cols-2'
                          : participants.length <= 4
                          ? 'grid-cols-1 md:grid-cols-2'
                          : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
                      }`
                    : 'relative w-full min-h-full'
                }
              >
                {participants.map((participant) => {
                  const winState = windows[participant.identity] || {
                    id: participant.identity,
                    x: 40,
                    y: 90,
                    width: 580,
                    height: 380,
                    floating: false,
                    minimized: false,
                    maximized: false,
                    z: 1,
                  }

                  return (
                    <div
                      key={participant.identity}
                      className={isAutoArrange ? 'aspect-video min-h-[260px]' : ''}
                    >
                      <ParticipantWindow
                        participant={participant}
                        windowState={winState}
                        filterMode={filterMode}
                        isAutoArrange={isAutoArrange}
                        room={room}
                        onUpdateState={(patch) => updateWindowState(participant.identity, patch)}
                        onFocus={() => bringToFront(participant.identity)}
                        onClose={() => handleParticipantLeft(participant.identity)}
                        onPopout={() => openPopoutWindow(participant.identity)}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </main>

          {/* Mapa Global de Todos los Agentes en la Sala */}
          <GlobalAgentsMap participants={participants} roomName={currentRoomName} />
        </div>
      </div>
    </div>
  )
}
