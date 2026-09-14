'use client'

import { useEffect, useRef, useCallback } from 'react'
import { LIVEKIT_CONFIG } from '@/lib/livekit-config'
import { useMultiRoomManager } from '@/lib/useMultiRoomManager'
import type { RoomSummary, ViewFilterMode, WindowState } from '@/types/monitor'
import { RoomHeader } from './RoomHeader'
import { SidebarRooms } from './SidebarRooms'
import { ParticipantWindow } from './ParticipantWindow'
import { GlobalAgentsMap } from './GlobalAgentsMap'
import { Radio, ShieldAlert } from 'lucide-react'
import { useState } from 'react'

export function VideoRoomWorkspace() {
  // ─── Hook central multi-room ────────────────────────────────────────────────
  const {
    participants,
    windows,
    connectedRoomNames,
    isAnyConnected,
    isAudioUnlocked,
    micEnabled,
    syncRooms,
    disconnectAll,
    toggleMic,
    changeAudioDevice,
    unlockAudioManually,
    getRooms,
    getRoomByName,
    bringToFront,
    updateWindowState,
  } = useMultiRoomManager()

  // Estado de UI no gestionado por el hook
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [isPollingRooms, setIsPollingRooms] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [isAutoArrange, setIsAutoArrange] = useState(true)
  const [filterMode, setFilterMode] = useState<ViewFilterMode>('all')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Ref estable para syncRooms (evita closure stale en setInterval)
  const syncRoomsRef = useRef(syncRooms)
  useEffect(() => { syncRoomsRef.current = syncRooms }, [syncRooms])

  // ─── Auto-desbloquear audio en el primer gesto del usuario ─────────────────
  useEffect(() => {
    const handleUserGesture = () => {
      unlockAudioManually()
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

  // ─────────────────────────────────────────────────────────────────────────────
  // CONSULTA DE SALAS ACTIVAS (API REST Twirp) + SINCRONIZACIÓN MULTI-ROOM
  // ─────────────────────────────────────────────────────────────────────────────
  const fetchActiveRooms = useCallback(async () => {
    try {
      setIsPollingRooms(true)
      setConnectionError(null)
      const res = await fetch('/api/livekit/rooms')

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

        // Extraer nombres de salas activas (cascos conectados o publicando)
        const activeNames = formatted
          .filter((r) => r.isLive || r.numPublishers > 0 || r.numParticipants > 0)
          .map((r) => r.name)

        // Si no hay ninguna sala detectada en LiveKit pero existe sala por defecto, monitorearla opcionalmente
        // Sincronizar: conecta a nuevas salas, desconecta las que desaparecieron
        syncRoomsRef.current(activeNames)
      } else {
        const errData = await res.json().catch(() => ({}))
        console.warn('[Rooms] Error listando salas:', res.status, errData)
        setConnectionError(`Error consultando salas activas (HTTP ${res.status})`)
      }
    } catch (err: any) {
      console.warn('[Rooms] Error consultando lista de salas LiveKit:', err)
      setConnectionError('Sin conexión al servidor de monitoreo. Reintentando...')
    } finally {
      setIsPollingRooms(false)
    }
  }, []) // sin deps: usa ref para syncRooms

  // Iniciar polling al montar y desconectar todo al desmontar
  useEffect(() => {
    fetchActiveRooms()
    const interval = setInterval(fetchActiveRooms, LIVEKIT_CONFIG.pollIntervalMs)
    return () => {
      clearInterval(interval)
      disconnectAll()
    }
  }, []) // solo al montar/desmontar

  // ─── Soporte Multi-monitor (Popout) ─────────────────────────────────────────
  // Cada participante conoce su propia roomName — usarla para el popout
  const openPopoutWindow = (identity: string, roomName: string) => {
    const popoutUrl = `/popout?room=${encodeURIComponent(roomName)}&agent=${encodeURIComponent(identity)}`
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

  const isConnected = isAnyConnected
  const isConnecting = isPollingRooms && !isAnyConnected

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 text-slate-900 font-sans">
      {/* Panel Lateral de Agentes Conectados */}
      <SidebarRooms
        connectedRoomNames={connectedRoomNames}
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
          rooms={getRooms()}
          isConnected={isConnected}
          isConnecting={isConnecting}
          participantsCount={participants.length}
          connectedRoomsCount={connectedRoomNames.length}
          isAudioUnlocked={isAudioUnlocked}
          onToggleMic={toggleMic}
          onChangeDevice={changeAudioDevice}
          onUnlockAudio={unlockAudioManually}
          micEnabled={micEnabled}
          isAutoArrange={isAutoArrange}
          filterMode={filterMode}
          onToggleAutoArrange={() => setIsAutoArrange(!isAutoArrange)}
          onChangeFilter={setFilterMode}
          onDisconnect={disconnectAll}
        />

        {/* Contenedor Horizontal: Área de Trabajo + Mapa Global */}
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
                  Tan pronto como un casco inicie su transmisión, su video y mapa GPS
                  aparecerán aquí automáticamente. Cada casco tiene su propia sala LiveKit.
                </p>
                <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                  <span className="size-2 rounded-full bg-emerald-400 animate-ping" />
                  <span>
                    {connectedRoomNames.length > 0
                      ? `Conectado a ${connectedRoomNames.length} sala(s): ${connectedRoomNames.join(', ')}`
                      : 'Escaneando salas activas...'}
                  </span>
                </div>
              </div>
            ) : (
              /* Cuadrícula de ventanas de participantes */
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
                  const winState: WindowState = windows[participant.identity] || {
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
                        room={getRoomByName(participant.roomName) ?? null}
                        onUpdateState={(patch) => updateWindowState(participant.identity, patch)}
                        onFocus={() => bringToFront(participant.identity)}
                        onClose={() => {}}
                        onPopout={() => openPopoutWindow(participant.identity, participant.roomName || '')}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </main>

          {/* Mapa Global de Todos los Agentes */}
          <GlobalAgentsMap
            participants={participants}
            roomName={connectedRoomNames.join(', ')}
          />
        </div>
      </div>
    </div>
  )
}
