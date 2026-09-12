'use client'

import { useRef, useState, useCallback } from 'react'
import {
  Users,
  Radio,
  RefreshCw,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Navigation,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
  Pin,
  PinOff,
  Maximize2,
  Minimize2,
  ExternalLink,
  Expand,
  Shrink,
  GripVertical,
} from 'lucide-react'
import type { HelmetParticipant } from '@/types/monitor'

// ─── Tipos para Drag & Resize ────────────────────────────────────────────────
type ResizeMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 280
const MIN_H = 200
const TOOLBAR_H = 44

interface FloatState {
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
  maximized: boolean
}

// ─── Hook drag + resize genérico ──────────────────────────────────────────────
function useDragResize(
  state: { x: number; y: number; width: number; height: number },
  onUpdate: (patch: Partial<{ x: number; y: number; width: number; height: number }>) => void,
  enabled: boolean
) {
  const origin = useRef({ mx: 0, my: 0, ox: 0, oy: 0, ow: 0, oh: 0 })
  const mode = useRef<ResizeMode>('move')
  const active = useRef(false)

  const startDrag = useCallback(
    (e: React.PointerEvent, m: ResizeMode = 'move') => {
      if (!enabled) return
      e.preventDefault()
      e.stopPropagation()
      mode.current = m
      active.current = true
      origin.current = {
        mx: e.clientX,
        my: e.clientY,
        ox: state.x,
        oy: state.y,
        ow: state.width,
        oh: state.height,
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [enabled, state]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!active.current) return
      const { mx, my, ox, oy, ow, oh } = origin.current
      const dx = e.clientX - mx
      const dy = e.clientY - my
      const m = mode.current
      let nx = ox,
        ny = oy,
        nw = ow,
        nh = oh
      if (m === 'move') {
        nx = Math.max(0, ox + dx)
        ny = Math.max(0, oy + dy)
      } else {
        if (m.includes('e')) nw = Math.max(MIN_W, ow + dx)
        if (m.includes('s')) nh = Math.max(MIN_H, oh + dy)
        if (m.includes('w')) {
          nw = Math.max(MIN_W, ow - dx)
          nx = ox + ow - nw
        }
        if (m.includes('n')) {
          nh = Math.max(MIN_H, oh - dy)
          ny = oy + oh - nh
        }
      }
      onUpdate({ x: nx, y: ny, width: nw, height: nh })
    },
    [onUpdate]
  )

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    active.current = false
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch (_) {}
  }, [])

  return { startDrag, onPointerMove, onPointerUp }
}

const RESIZE_CURSORS: Record<ResizeMode, string> = {
  move: 'move',
  n: 'n-resize',
  s: 's-resize',
  e: 'e-resize',
  w: 'w-resize',
  ne: 'ne-resize',
  nw: 'nw-resize',
  se: 'se-resize',
  sw: 'sw-resize',
}

const RESIZE_STYLES: Partial<Record<ResizeMode, React.CSSProperties>> = {
  n: { top: 0, left: 6, right: 6, height: 6 },
  s: { bottom: 0, left: 6, right: 6, height: 6 },
  e: { top: 6, right: 0, bottom: 6, width: 6 },
  w: { top: 6, left: 0, bottom: 6, width: 6 },
  ne: { top: 0, right: 0, width: 14, height: 14 },
  nw: { top: 0, left: 0, width: 14, height: 14 },
  se: { bottom: 0, right: 0, width: 14, height: 14 },
  sw: { bottom: 0, left: 0, width: 14, height: 14 },
}

function ResizeHandle({
  mode,
  onStart,
}: {
  mode: ResizeMode
  onStart: (e: React.PointerEvent, m: ResizeMode) => void
}) {
  return (
    <div
      style={{
        position: 'absolute',
        zIndex: 25,
        cursor: RESIZE_CURSORS[mode],
        ...RESIZE_STYLES[mode],
      }}
      onPointerDown={(e) => onStart(e, mode)}
    />
  )
}

// ─── Props del Componente ─────────────────────────────────────────────────────
interface SidebarRoomsProps {
  currentRoomName: string
  participants: HelmetParticipant[]
  isOpen: boolean
  isPolling: boolean
  onToggleOpen: () => void
  onRefreshRooms: () => void
  onFocusParticipant: (id: string) => void
  className?: string
}

export function SidebarRooms({
  currentRoomName,
  participants,
  isOpen,
  isPolling,
  onToggleOpen,
  onRefreshRooms,
  onFocusParticipant,
  className = '',
}: SidebarRoomsProps) {
  // ── Estado de Ventana Flotante / Redimensionable ─────────────────────────────
  const [isFloating, setIsFloating] = useState(false)
  const [floatState, setFloatState] = useState<FloatState>({
    x: 70,
    y: 90,
    width: 340,
    height: 520,
    minimized: false,
    maximized: false,
  })

  // Hook de drag y resize
  const drag = useDragResize(
    floatState,
    (patch) => setFloatState((prev) => ({ ...prev, ...patch })),
    isFloating && !floatState.maximized
  )

  // Abrir en ventana independiente (para otro monitor o pantalla)
  const openExternalPopout = () => {
    const popoutUrl = `/popout?view=agents-list&room=${encodeURIComponent(currentRoomName)}`
    const popoutWin = window.open(
      popoutUrl,
      'AgentsList_ExternalWindow',
      'width=420,height=680,menubar=no,toolbar=no,location=no,status=no,resizable=yes'
    )
    if (popoutWin) {
      popoutWin.focus()
    } else {
      alert(
        'El navegador bloqueó la ventana emergente. Habilita las ventanas emergentes para este sitio.'
      )
    }
  }

  // Si está completamente cerrado (y no está flotando)
  if (!isOpen && !isFloating) {
    return (
      <button
        type="button"
        onClick={onToggleOpen}
        title="Abrir panel de agentes"
        className="fixed top-20 left-3 z-30 p-2.5 rounded-xl bg-slate-900/90 border border-slate-700/80 text-slate-300 hover:text-white shadow-xl backdrop-blur-md transition-transform hover:scale-105"
      >
        <PanelLeft className="size-4 text-blue-400" />
      </button>
    )
  }

  // Estilos de la ventana flotante
  let floatingStyle: React.CSSProperties = {}
  if (isFloating) {
    if (floatState.maximized) {
      floatingStyle = {
        position: 'fixed',
        inset: 0,
        zIndex: 9150,
      }
    } else {
      floatingStyle = {
        position: 'fixed',
        left: floatState.x,
        top: floatState.y,
        width: floatState.width,
        height: floatState.minimized ? TOOLBAR_H : floatState.height,
        zIndex: 9150,
      }
    }
  }

  // ── Contenido de la lista de agentes (compartido entre acoplado y flotante) ──
  const renderAgentsContent = () => (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col select-none bg-white">
        <div className="flex items-center justify-between px-1 mb-2">
          <div className="flex items-center gap-2">
            <Users className="size-3.5 text-blue-400" />
            <span className="text-[11px] font-bold text-slate-300 uppercase tracking-wider">
              Agentes en Sala
            </span>
          </div>
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full font-bold transition-colors ${
              participants.length > 0
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-slate-900 text-slate-500 border border-slate-800'
            }`}
          >
            {participants.length} conectados
          </span>
        </div>

        {/* Estado Vacío */}
        {participants.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 select-none">
            <div className="size-12 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-center text-slate-600 mb-2.5">
              <Users className="size-5 text-slate-500/70" />
            </div>
            <p className="text-xs font-semibold text-slate-400">Sin agentes conectados</p>
            <p className="text-[10px] text-slate-600 mt-1 max-w-[200px] leading-relaxed">
              Los cascos activos aparecerán aquí automáticamente al iniciar su transmisión.
            </p>
          </div>
        ) : (
          /* Lista Dinámica */
          <div className="space-y-2">
            {participants.map((p) => {
              const hasGps = Boolean(p.gps && typeof p.gps.lat === 'number')
              return (
                <div
                  key={p.id}
                  onClick={() => onFocusParticipant(p.id)}
                  className="p-3 rounded-xl bg-white border border-slate-200 hover:border-blue-400 hover:bg-blue-50 cursor-pointer transition-all shadow-sm group"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="size-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-xs font-bold text-blue-300 shrink-0">
                        {p.initials}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-slate-800 truncate group-hover:text-blue-600 transition-colors">
                          {p.name}
                        </p>
                        <p className="text-[10px] text-slate-400 truncate font-mono">
                          {p.identity}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-[10px] font-bold text-emerald-400">EN VIVO</span>
                    </div>
                  </div>

                  {/* Badges de Estado: Cámara, Micrófono y GPS */}
                  <div className="flex items-center justify-between pt-2 border-t border-slate-800/60 text-[10px] text-slate-400">
                    <div className="flex items-center gap-2">
                      {/* Estado de Cámara */}
                      <span
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded ${
                          p.hasVideoTrack && !p.isCameraOff
                            ? 'bg-blue-500/15 text-blue-300'
                            : 'bg-slate-800 text-slate-500'
                        }`}
                      >
                        {p.hasVideoTrack && !p.isCameraOff ? (
                          <>
                            <Video className="size-3" />
                            <span>Cámara</span>
                          </>
                        ) : (
                          <>
                            <VideoOff className="size-3" />
                            <span>Sin video</span>
                          </>
                        )}
                      </span>

                      {/* Estado de Audio */}
                      <span
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded ${
                          p.hasAudioTrack && !p.isAudioMuted
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-slate-800 text-slate-500'
                        }`}
                      >
                        {p.hasAudioTrack && !p.isAudioMuted ? (
                          <Mic className="size-3" />
                        ) : (
                          <MicOff className="size-3" />
                        )}
                        <span>Audio</span>
                      </span>

                      {/* Estado de GPS */}
                      {hasGps && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
                          <Navigation className="size-3" />
                          <span>
                            {p.gps?.speed != null ? `${p.gps.speed.toFixed(0)} km/h` : 'GPS'}
                          </span>
                        </span>
                      )}
                    </div>

                    <ChevronRight className="size-3.5 text-slate-600 group-hover:text-slate-300 transition-colors" />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Pie del Panel */}
      <div className="p-3 border-t border-slate-200 text-[11px] text-slate-500 flex items-center justify-between bg-slate-50 shrink-0 select-none">
        <span>Sala activa:</span>
        <span className="font-mono text-slate-700 font-semibold truncate max-w-[140px]">
          {currentRoomName || 'jhoan'}
        </span>
      </div>
    </>
  )

  return (
    <>
      {/* ── 1. Panel Acoplado en Barra Lateral Izquierda ── */}
      {!isFloating && (
        <aside
          className={`w-80 shrink-0 h-full bg-white border-r border-slate-200 flex flex-col z-20 shadow-md transition-all ${className}`}
        >
          {/* Cabecera del Panel Acoplado */}
          <div className="p-3.5 border-b border-slate-200 flex items-center justify-between select-none bg-slate-50">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="size-8 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0">
                <Radio className="size-4 animate-pulse" />
              </div>
              <div className="min-w-0">
                <h2 className="text-xs font-bold text-slate-700 uppercase tracking-wider truncate">
                  Centro de Control
                </h2>
                <p className="text-[10px] text-slate-500 truncate">Agentes LiveKit</p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {/* Botón Flotar */}
              <button
                type="button"
                onClick={() => setIsFloating(true)}
                title="Hacer ventana flotante y ajustable"
                className="p-1.5 rounded-lg text-slate-400 hover:text-blue-300 hover:bg-blue-500/10 transition-colors"
              >
                <Pin className="size-3.5" />
              </button>

              {/* Botón Popout para 2do monitor */}
              <button
                type="button"
                onClick={openExternalPopout}
                title="Abrir en ventana externa (para otra pantalla o monitor)"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
              >
                <ExternalLink className="size-3.5" />
              </button>

              {/* Refrescar */}
              <button
                type="button"
                onClick={onRefreshRooms}
                disabled={isPolling}
                title="Actualizar estado"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors"
              >
                <RefreshCw
                  className={`size-3.5 ${isPolling ? 'animate-spin text-blue-400' : ''}`}
                />
              </button>

              {/* Cerrar / Contraer */}
              <button
                type="button"
                onClick={onToggleOpen}
                title="Contraer panel"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors"
              >
                <PanelLeftClose className="size-4" />
              </button>
            </div>
          </div>

          {/* Lista de agentes */}
          {renderAgentsContent()}
        </aside>
      )}

      {/* ── Botón en el lateral cuando el panel está flotando ── */}
      {isFloating && (
        <button
          type="button"
          onClick={() => setIsFloating(false)}
          title="Re-acoplar panel de agentes a la barra lateral"
          className="fixed top-20 left-3 z-30 p-2.5 rounded-xl bg-blue-600/20 border border-blue-500/40 text-blue-300 hover:bg-blue-600/30 hover:text-white shadow-xl backdrop-blur-md transition-transform hover:scale-105 flex items-center gap-1.5 text-xs font-semibold"
        >
          <PinOff className="size-4" />
          <span className="hidden sm:inline">Acoplar Agentes</span>
        </button>
      )}

      {/* ── 2. Ventana Flotante / Redimensionable y Arrastrable ── */}
      {isFloating && (
        <div
          style={floatingStyle}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          className="flex flex-col rounded-2xl border border-blue-500/40 bg-slate-900 shadow-2xl shadow-black/80 overflow-hidden select-none"
        >
          {/* Barra de título de la ventana flotante (arrastrable) */}
          <div
            onPointerDown={(e) => drag.startDrag(e, 'move')}
            className="flex h-11 shrink-0 items-center justify-between px-3 bg-slate-950 border-b border-slate-800 cursor-grab active:cursor-grabbing select-none"
          >
            <div className="flex items-center gap-2 min-w-0">
              <GripVertical className="size-4 text-slate-500 shrink-0" />
              <Users className="size-4 text-blue-400 shrink-0" />
              <span className="truncate text-xs font-bold text-slate-100">
                Lista de Agentes ({participants.length})
              </span>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {/* Refrescar */}
              <button
                type="button"
                onClick={onRefreshRooms}
                disabled={isPolling}
                title="Actualizar estado"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              >
                <RefreshCw
                  className={`size-3.5 ${isPolling ? 'animate-spin text-blue-400' : ''}`}
                />
              </button>

              {/* Botón Popout para 2do monitor */}
              <button
                type="button"
                onClick={openExternalPopout}
                title="Abrir en ventana externa (para otra pantalla o monitor)"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
              >
                <ExternalLink className="size-3.5" />
              </button>

              {/* Botón Maximizar / Restaurar */}
              <button
                type="button"
                onClick={() =>
                  setFloatState((prev) => ({
                    ...prev,
                    maximized: !prev.maximized,
                    minimized: false,
                  }))
                }
                title={floatState.maximized ? 'Restaurar tamaño' : 'Maximizar'}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
              >
                {floatState.maximized ? <Shrink className="size-3.5" /> : <Expand className="size-3.5" />}
              </button>

              {/* Botón Minimizar / Restaurar */}
              <button
                type="button"
                onClick={() =>
                  setFloatState((prev) => ({
                    ...prev,
                    minimized: !prev.minimized,
                  }))
                }
                title={floatState.minimized ? 'Restaurar' : 'Minimizar'}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
              >
                {floatState.minimized ? (
                  <Maximize2 className="size-3.5" />
                ) : (
                  <Minimize2 className="size-3.5" />
                )}
              </button>

              {/* Botón Acoplar de vuelta */}
              <button
                type="button"
                onClick={() => setIsFloating(false)}
                title="Re-acoplar a la barra lateral"
                className="p-1.5 rounded-lg text-slate-400 hover:text-blue-400 hover:bg-slate-800 transition-colors"
              >
                <PinOff className="size-3.5" />
              </button>
            </div>
          </div>

          {/* Contenido de la ventana flotante */}
          {!floatState.minimized && (
            <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden bg-slate-950/70">
              {renderAgentsContent()}

              {/* Tiradores de redimensión en los 8 bordes y esquinas */}
              {!floatState.maximized &&
                (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeMode[]).map((m) => (
                  <ResizeHandle key={m} mode={m} onStart={drag.startDrag} />
                ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
