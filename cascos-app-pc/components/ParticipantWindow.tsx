'use client'

import { useState, useRef, useCallback } from 'react'
import {
  GripVertical,
  Pin,
  PinOff,
  Minimize2,
  Maximize2,
  ExternalLink,
  X,
  Video,
  Map,
  Expand,
  Shrink,
} from 'lucide-react'
import type { Room } from 'livekit-client'
import type { HelmetParticipant, WindowState, ViewFilterMode } from '@/types/monitor'
import { useAgentRecorder } from '@/lib/useAgentRecorder'
import { ParticipantVideo } from './ParticipantVideo'
import { ParticipantMap } from './ParticipantMap'

// ─── Tipos locales ────────────────────────────────────────────────────────────
interface FloatWin {
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
}

type ResizeMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 280
const MIN_H = 180
const TOOLBAR_H = 44

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
      origin.current = { mx: e.clientX, my: e.clientY, ox: state.x, oy: state.y, ow: state.width, oh: state.height }
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
      let nx = ox, ny = oy, nw = ow, nh = oh
      if (m === 'move') { nx = Math.max(0, ox + dx); ny = Math.max(0, oy + dy) }
      else {
        if (m.includes('e')) nw = Math.max(MIN_W, ow + dx)
        if (m.includes('s')) nh = Math.max(MIN_H, oh + dy)
        if (m.includes('w')) { nw = Math.max(MIN_W, ow - dx); nx = ox + ow - nw }
        if (m.includes('n')) { nh = Math.max(MIN_H, oh - dy); ny = oy + oh - nh }
      }
      onUpdate({ x: nx, y: ny, width: nw, height: nh })
    },
    [onUpdate]
  )

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    active.current = false
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch (_) {}
  }, [])

  return { startDrag, onPointerMove, onPointerUp }
}

// ─── Handle de resize ─────────────────────────────────────────────────────────
const RESIZE_CURSORS: Record<ResizeMode, string> = {
  move: 'move', n: 'n-resize', s: 's-resize', e: 'e-resize', w: 'w-resize',
  ne: 'ne-resize', nw: 'nw-resize', se: 'se-resize', sw: 'sw-resize',
}
const RESIZE_STYLES: Partial<Record<ResizeMode, React.CSSProperties>> = {
  n:  { top: 0,    left: 6,  right: 6,  height: 6 },
  s:  { bottom: 0, left: 6,  right: 6,  height: 6 },
  e:  { top: 6,    right: 0, bottom: 6, width: 6 },
  w:  { top: 6,    left: 0,  bottom: 6, width: 6 },
  ne: { top: 0,    right: 0, width: 14, height: 14 },
  nw: { top: 0,    left: 0,  width: 14, height: 14 },
  se: { bottom: 0, right: 0, width: 14, height: 14 },
  sw: { bottom: 0, left: 0,  width: 14, height: 14 },
}

function ResizeHandle({ mode, onStart }: { mode: ResizeMode; onStart: (e: React.PointerEvent, m: ResizeMode) => void }) {
  return (
    <div
      style={{ position: 'absolute', zIndex: 10, cursor: RESIZE_CURSORS[mode], ...RESIZE_STYLES[mode] }}
      onPointerDown={(e) => onStart(e, mode)}
    />
  )
}

// ─── Sub-ventana flotante independiente (Video o Mapa) ────────────────────────
interface SubWindowProps {
  title: string
  icon: React.ReactNode
  accentColor: string
  win: FloatWin
  onUpdate: (patch: Partial<FloatWin>) => void
  onDock: () => void
  children: React.ReactNode
}

function SubFloatWindow({ title, icon, accentColor, win, onUpdate, onDock, children }: SubWindowProps) {
  const drag = useDragResize(win, (p) => onUpdate(p), true)
  const isMin = win.minimized

  return (
    <div
      style={{ position: 'fixed', left: win.x, top: win.y, width: win.width, height: isMin ? TOOLBAR_H : win.height, zIndex: 9100 }}
      className="flex flex-col rounded-xl border border-slate-700 shadow-2xl bg-slate-900 overflow-hidden"
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
    >
      {/* Barra */}
      <div
        style={{ borderLeftColor: accentColor, borderLeftWidth: 3 }}
        onPointerDown={(e) => drag.startDrag(e, 'move')}
        className="flex h-11 shrink-0 items-center justify-between px-3 bg-slate-950 border-b border-slate-800 cursor-grab active:cursor-grabbing select-none"
      >
        <div className="flex items-center gap-2 text-xs font-bold text-slate-100 min-w-0">
          {icon}
          <span className="truncate">{title}</span>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onUpdate({ minimized: !isMin })}
            className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            {isMin ? <Maximize2 className="size-3" /> : <Minimize2 className="size-3" />}
          </button>
          <button type="button" onClick={onDock}
            className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors" title="Acoplar de vuelta">
            <PinOff className="size-3" />
          </button>
        </div>
      </div>

      {/* Contenido */}
      {!isMin && (
        <div className="flex-1 min-h-0 relative">
          {children}
          {(['n','s','e','w','ne','nw','se','sw'] as ResizeMode[]).map((m) => (
            <ResizeHandle key={m} mode={m} onStart={drag.startDrag} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── ParticipantWindow principal ──────────────────────────────────────────────
interface ParticipantWindowProps {
  participant: HelmetParticipant
  windowState: WindowState
  filterMode: ViewFilterMode
  isAutoArrange: boolean
  room?: Room | null
  onUpdateState: (patch: Partial<WindowState>) => void
  onFocus: () => void
  onClose: () => void
  onPopout: () => void
}

export function ParticipantWindow({
  participant, windowState, filterMode, isAutoArrange, room,
  onUpdateState, onFocus, onClose, onPopout,
}: ParticipantWindowProps) {
  const recorder = useAgentRecorder(participant, room)
  const [videoFloat, setVideoFloat] = useState<FloatWin | null>(null)
  const [mapFloat,   setMapFloat]   = useState<FloatWin | null>(null)

  const isFloating  = windowState.floating && !isAutoArrange
  const isMinimized = windowState.minimized
  const isMaximized = windowState.maximized

  const drag = useDragResize(windowState, (p) => onUpdateState(p), isFloating)

  const toggleFloat    = () => onUpdateState({ floating: !windowState.floating })
  const toggleMaximize = () => onUpdateState({ maximized: !windowState.maximized, minimized: false })

  const floatVideo = () => setVideoFloat({ x: 120, y: 100, width: 520, height: 340, minimized: false })
  const floatMap   = () => setMapFloat({   x: 660, y: 100, width: 480, height: 380, minimized: false })

  // Estilos positionals
  let mainStyle: React.CSSProperties = {}
  if (isMaximized) {
    mainStyle = { position: 'fixed', inset: 0, zIndex: 9300 }
  } else if (isFloating) {
    mainStyle = {
      position: 'fixed',
      left: windowState.x,
      top: windowState.y,
      width: windowState.width,
      height: windowState.height,
      zIndex: windowState.z,
    }
  }

  const showVideo = !videoFloat && (filterMode === 'all' || filterMode === 'video')
  const showMap   = !mapFloat   && (filterMode === 'all' || filterMode === 'map')

  return (
    <>
      {/* ── Ventana principal ── */}
      <div
        style={mainStyle}
        onPointerDown={onFocus}
        onPointerMove={isFloating ? drag.onPointerMove : undefined}
        onPointerUp={isFloating ? drag.onPointerUp : undefined}
        className={[
          'flex flex-col overflow-hidden rounded-2xl border bg-white shadow-md transition-shadow duration-200',
          participant.isSpeaking
            ? 'border-blue-400 ring-2 ring-blue-400/30 shadow-blue-200/50'
            : 'border-slate-200 hover:border-slate-300',
          !isFloating && !isMaximized ? 'h-full' : '',
          isFloating ? 'shadow-2xl' : '',
        ].join(' ')}
      >
        {/* Barra de título */}
        <div
          onPointerDown={isFloating ? (e) => drag.startDrag(e, 'move') : undefined}
          className={[
            'flex h-11 shrink-0 items-center justify-between px-3 border-b border-slate-100 bg-slate-50 select-none',
            isFloating ? 'cursor-grab active:cursor-grabbing' : '',
          ].join(' ')}
        >
          <div className="flex items-center gap-2 min-w-0">
            <GripVertical className={`size-4 text-slate-500 ${isFloating ? '' : 'opacity-40'}`} />
            <span className="size-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="truncate text-xs font-bold text-slate-800">{participant.name}</span>
            {isFloating && (
              <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 text-[10px] font-medium border border-blue-500/30">
                Flotante
              </span>
            )}
          </div>

          <div className="flex items-center gap-0.5">
            {/* Separar Video */}
            {!isMinimized && !videoFloat && (filterMode === 'all' || filterMode === 'video') && (
              <button type="button" onClick={(e) => { e.stopPropagation(); floatVideo() }}
                title="Separar video en sub-ventana" className="p-1.5 rounded-lg text-slate-400 hover:text-blue-300 hover:bg-blue-500/10 transition-colors">
                <Video className="size-3.5" />
              </button>
            )}
            {/* Separar Mapa */}
            {!isMinimized && !mapFloat && (filterMode === 'all' || filterMode === 'map') && (
              <button type="button" onClick={(e) => { e.stopPropagation(); floatMap() }}
                title="Separar mapa en sub-ventana" className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors">
                <Map className="size-3.5" />
              </button>
            )}
            {/* Popout multi-monitor */}
            <button type="button" onClick={(e) => { e.stopPropagation(); onPopout() }}
              title="Separar en ventana externa (multi-monitor)" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
              <ExternalLink className="size-3.5" />
            </button>
            {/* Float/Dock */}
            {!isAutoArrange && (
              <button type="button" onClick={(e) => { e.stopPropagation(); toggleFloat() }}
                title={windowState.floating ? 'Acoplar a cuadrícula' : 'Hacer ventana flotante'}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
                {windowState.floating ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </button>
            )}
            {/* Botón Grabar Audio y Video */}
            {!recorder.isRecording ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  recorder.startRecording()
                }}
                title="Grabar video y audio de este agente"
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30 transition-all hover:scale-105 active:scale-95"
              >
                <span className="size-2 rounded-full bg-red-500 shrink-0" />
                <span className="hidden sm:inline">Grabar</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  recorder.stopRecording()
                }}
                title="Detener grabación y elegir dónde guardarla"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-600/40 animate-pulse transition-all hover:scale-105 active:scale-95"
              >
                <span className="size-2 rounded-full bg-white animate-ping shrink-0" />
                <span>REC {recorder.formattedTime}</span>
                <span className="text-[10px] opacity-90 font-mono ml-0.5">■ Guardar</span>
              </button>
            )}

            {/* Maximizar / Restaurar a pantalla completa */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleMaximize() }}
              title={isMaximized ? 'Restaurar tamaño' : 'Maximizar'}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            >
              {isMaximized ? <Shrink className="size-3.5" /> : <Expand className="size-3.5" />}
            </button>

            {/* Cerrar */}
            <button type="button" onClick={(e) => { e.stopPropagation(); onClose() }}
              title="Ocultar ventana"
              className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors">
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Contenido */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
          {/* Video acoplado */}
          {showVideo && (
            <div className={`relative min-h-[200px] ${showVideo && showMap ? 'flex-1 md:w-1/2 border-b md:border-b-0 md:border-r border-slate-800' : 'w-full h-full'}`}>
              <ParticipantVideo
                participant={participant}
                isMaximized={isMaximized}
                isRecording={recorder.isRecording}
                recordingTime={recorder.formattedTime}
              />
            </div>
          )}
          {/* Placeholder video flotando */}
          {videoFloat && (filterMode === 'all' || filterMode === 'video') && (
            <div className="flex-1 flex items-center justify-center bg-slate-950/60 border-r border-slate-800/50 min-h-[200px]">
              <div className="text-center p-4">
                <Video className="size-7 mx-auto mb-2 text-blue-400/40" />
                <p className="text-xs text-slate-500">Video en ventana flotante</p>
                <button type="button" onClick={() => setVideoFloat(null)} className="mt-2 text-blue-400 hover:underline text-[11px]">Acoplar aquí</button>
              </div>
            </div>
          )}
          {/* Mapa acoplado */}
          {showMap && (
            <div className={`relative min-h-[200px] ${showVideo && showMap ? 'flex-1 md:w-1/2' : 'w-full h-full'}`}>
              <ParticipantMap participant={participant} />
            </div>
          )}
          {/* Placeholder mapa flotando */}
          {mapFloat && (filterMode === 'all' || filterMode === 'map') && (
            <div className="flex-1 flex items-center justify-center bg-slate-950/60 min-h-[200px]">
              <div className="text-center p-4">
                <Map className="size-7 mx-auto mb-2 text-emerald-400/40" />
                <p className="text-xs text-slate-500">Mapa en ventana flotante</p>
                <button type="button" onClick={() => setMapFloat(null)} className="mt-2 text-emerald-400 hover:underline text-[11px]">Acoplar aquí</button>
              </div>
            </div>
          )}
        </div>

        {/* Handles de resize (solo flotante, no maximizado) */}
        {isFloating && !isMaximized && (
          (['n','s','e','w','ne','nw','se','sw'] as ResizeMode[]).map((m) => (
            <ResizeHandle key={m} mode={m} onStart={drag.startDrag} />
          ))
        )}
      </div>

      {/* ── Sub-ventana Video ── */}
      {videoFloat && (
        <SubFloatWindow
          title={`Video — ${participant.name}`}
          icon={<Video className="size-3.5 text-blue-400" />}
          accentColor="#3b82f6"
          win={videoFloat}
          onUpdate={(p) => setVideoFloat((prev) => prev ? { ...prev, ...p } : null)}
          onDock={() => setVideoFloat(null)}
        >
          <ParticipantVideo participant={participant} isMaximized={false} />
        </SubFloatWindow>
      )}

      {/* ── Sub-ventana Mapa ── */}
      {mapFloat && (
        <SubFloatWindow
          title={`Mapa GPS — ${participant.name}`}
          icon={<Map className="size-3.5 text-emerald-400" />}
          accentColor="#10b981"
          win={mapFloat}
          onUpdate={(p) => setMapFloat((prev) => prev ? { ...prev, ...p } : null)}
          onDock={() => setMapFloat(null)}
        >
          <ParticipantMap participant={participant} />
        </SubFloatWindow>
      )}
    </>
  )
}
