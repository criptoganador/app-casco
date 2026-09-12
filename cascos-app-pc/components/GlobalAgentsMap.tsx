'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Map,
  LocateFixed,
  ChevronLeft,
  ChevronRight,
  Navigation,
  Users,
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

// ─── Paleta de colores por agente (8 colores, se ciclan si hay más agentes) ───
const AGENT_COLORS = [
  '#3b82f6', // blue-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#8b5cf6', // violet-500
  '#ef4444', // red-500
  '#06b6d4', // cyan-500
  '#f97316', // orange-500
  '#ec4899', // pink-500
]

function getAgentColor(index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length]
}

// ─── Tipos para Drag & Resize ────────────────────────────────────────────────
type ResizeMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 320
const MIN_H = 240
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

// ─── Tipos de capas ───────────────────────────────────────────────────────────
interface AgentLayer {
  marker: any
  polyline: any
  color: string
}

interface GlobalAgentsMapProps {
  participants: HelmetParticipant[]
  roomName?: string
  className?: string
}

// ─── Componente principal ─────────────────────────────────────────────────────
export function GlobalAgentsMap({
  participants,
  roomName = 'cascos-emergencia',
  className = '',
}: GlobalAgentsMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const agentLayersRef = useRef<Record<string, AgentLayer>>({})
  const [isMapReady, setIsMapReady] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)

  // ── Estado de Ventana Flotante / Redimensionable ─────────────────────────────
  const [isFloating, setIsFloating] = useState(false)
  const [floatState, setFloatState] = useState<FloatState>({
    x: 120,
    y: 90,
    width: 620,
    height: 480,
    minimized: false,
    maximized: false,
  })

  // ── Contar agentes con GPS ─────────────────────────────────────────────────
  const agentsWithGps = participants.filter(
    (p) => typeof p.gps?.lat === 'number' && typeof p.gps?.lng === 'number'
  )

  // ── Hook de arrastre y redimensión para modo flotante ──────────────────────
  const drag = useDragResize(
    floatState,
    (patch) => {
      setFloatState((prev) => ({ ...prev, ...patch }))
      setTimeout(() => {
        mapInstanceRef.current?.invalidateSize()
      }, 50)
    },
    isFloating && !floatState.maximized
  )

  // ── Inicializar Leaflet (solo una vez al montar) ───────────────────────────
  useEffect(() => {
    let isMounted = true

    async function initMap() {
      if (typeof window === 'undefined' || !mapContainerRef.current || mapInstanceRef.current) return

      try {
        const L = (await import('leaflet')).default

        if (!isMounted || !mapContainerRef.current) return

        const map = L.map(mapContainerRef.current, {
          center: [4.711, -74.072],
          zoom: 13,
          zoomControl: true,
          attributionControl: false,
        })

        // Mover controles de zoom a la esquina inferior derecha
        map.zoomControl.setPosition('bottomright')

        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 19,
          subdomains: 'abcd',
        }).addTo(map)

        mapInstanceRef.current = map
        setIsMapReady(true)

        setTimeout(() => {
          map.invalidateSize()
        }, 300)
      } catch (err) {
        console.error('[GlobalAgentsMap] Error inicializando mapa:', err)
      }
    }

    initMap()

    return () => {
      isMounted = false
      if (mapInstanceRef.current) {
        try {
          mapInstanceRef.current.remove()
        } catch (e) {}
        mapInstanceRef.current = null
        agentLayersRef.current = {}
      }
    }
  }, [])

  // ── Sincronizar capas por agente cuando cambian los participantes ──────────
  useEffect(() => {
    if (!isMapReady || !mapInstanceRef.current) return

    async function syncLayers() {
      const L = (await import('leaflet')).default
      const map = mapInstanceRef.current
      if (!map) return

      const currentIdentities = new Set(participants.map((p) => p.identity))

      // Eliminar capas de agentes que ya no están
      Object.keys(agentLayersRef.current).forEach((identity) => {
        if (!currentIdentities.has(identity)) {
          const layer = agentLayersRef.current[identity]
          try {
            map.removeLayer(layer.marker)
            map.removeLayer(layer.polyline)
          } catch (e) {}
          delete agentLayersRef.current[identity]
        }
      })

      // Crear o actualizar capas por agente
      participants.forEach((participant, idx) => {
        const gps = participant.gps
        const hasCoords = typeof gps?.lat === 'number' && typeof gps?.lng === 'number'
        if (!hasCoords || !gps) return

        const color = getAgentColor(idx)
        const latLng: [number, number] = [gps.lat, gps.lng]
        const route = participant.routeHistory.length > 0 ? participant.routeHistory : [latLng]

        const existingLayer = agentLayersRef.current[participant.identity]

        if (!existingLayer) {
          // ── Crear icono personalizado con el color del agente ──
          const helmetIcon = L.divIcon({
            className: 'global-agent-pin',
            html: `
              <div class="global-radar-ping" style="border-color: ${color}; box-shadow: 0 0 0 0 ${color}55;"></div>
              <div class="global-helmet-core" style="background: ${color}22; border-color: ${color}; color: ${color};">🪖</div>
            `,
            iconSize: [40, 40],
            iconAnchor: [20, 20],
          })

          const marker = L.marker(latLng, { icon: helmetIcon }).addTo(map)
          marker.bindPopup(
            `<div style="font-family: monospace; font-size: 12px; min-width: 160px;">
              <b style="color: ${color};">${participant.name}</b><br/>
              <span style="color: #94a3b8;">Lat:</span> ${gps.lat.toFixed(5)}<br/>
              <span style="color: #94a3b8;">Lng:</span> ${gps.lng.toFixed(5)}<br/>
              ${typeof gps.speed === 'number' ? `<span style="color: #94a3b8;">Vel:</span> ${gps.speed.toFixed(1)} km/h<br/>` : ''}
              ${typeof gps.accuracy === 'number' ? `<span style="color: #94a3b8;">Precisión:</span> ±${gps.accuracy.toFixed(0)}m` : ''}
            </div>`,
            { maxWidth: 220 }
          )

          const polyline = L.polyline(route, {
            color,
            weight: 3,
            opacity: 0.75,
            lineJoin: 'round',
          }).addTo(map)

          agentLayersRef.current[participant.identity] = { marker, polyline, color }
        } else {
          // ── Actualizar posición y ruta ──
          try {
            existingLayer.marker.setLatLng(latLng)
            existingLayer.marker.setPopupContent(
              `<div style="font-family: monospace; font-size: 12px; min-width: 160px;">
                <b style="color: ${existingLayer.color};">${participant.name}</b><br/>
                <span style="color: #94a3b8;">Lat:</span> ${gps.lat.toFixed(5)}<br/>
                <span style="color: #94a3b8;">Lng:</span> ${gps.lng.toFixed(5)}<br/>
                ${typeof gps.speed === 'number' ? `<span style="color: #94a3b8;">Vel:</span> ${gps.speed.toFixed(1)} km/h<br/>` : ''}
                ${typeof gps.accuracy === 'number' ? `<span style="color: #94a3b8;">Precisión:</span> ±${gps.accuracy.toFixed(0)}m` : ''}
              </div>`
            )
            existingLayer.polyline.setLatLngs(
              participant.routeHistory.length > 0 ? participant.routeHistory : [latLng]
            )
          } catch (e) {}
        }
      })
    }

    syncLayers()
  }, [participants, isMapReady])

  // ── Centrar el mapa para que todos los agentes quepan en pantalla ──────────
  const fitAllAgents = useCallback(() => {
    if (!mapInstanceRef.current || agentsWithGps.length === 0) return

    async function doFit() {
      const L = (await import('leaflet')).default
      const map = mapInstanceRef.current
      if (!map) return

      if (agentsWithGps.length === 1 && agentsWithGps[0].gps) {
        map.setView([agentsWithGps[0].gps.lat, agentsWithGps[0].gps.lng], 16, { animate: true })
        return
      }

      const bounds = L.latLngBounds(
        agentsWithGps
          .filter((p) => p.gps)
          .map((p) => [p.gps!.lat, p.gps!.lng] as [number, number])
      )
      map.fitBounds(bounds, { padding: [32, 32], animate: true, maxZoom: 17 })
    }

    doFit()
  }, [agentsWithGps])

  // ── Invalidar tamaño cuando el panel o ventana cambia de estado ───────────
  useEffect(() => {
    if (mapInstanceRef.current) {
      setTimeout(() => {
        mapInstanceRef.current?.invalidateSize()
      }, 250)
    }
  }, [isCollapsed, isFloating, floatState.maximized, floatState.minimized])

  // ── Abrir en ventana externa para 2do monitor (Popout) ─────────────────────
  const openExternalPopout = () => {
    const popoutUrl = `/popout?view=global-map&room=${encodeURIComponent(roomName)}`
    const popoutWin = window.open(
      popoutUrl,
      'GlobalMap_ExternalWindow',
      'width=1000,height=720,menubar=no,toolbar=no,location=no,status=no,resizable=yes'
    )
    if (popoutWin) {
      popoutWin.focus()
    } else {
      alert(
        'El navegador bloqueó la ventana emergente. Habilita las ventanas emergentes para este sitio.'
      )
    }
  }

  // ── CSS global para los iconos de Leaflet personalizados ──────────────────
  useEffect(() => {
    const styleId = 'global-agents-map-styles'
    if (document.getElementById(styleId)) return

    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
      .global-agent-pin {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px !important;
        height: 40px !important;
        background: transparent !important;
        border: none !important;
      }
      .global-radar-ping {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid currentColor;
        animation: global-radar-expand 2s ease-out infinite;
        opacity: 0.6;
      }
      .global-helmet-core {
        position: relative;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        border: 2px solid;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        backdrop-filter: blur(4px);
        z-index: 1;
      }
      @keyframes global-radar-expand {
        0%   { transform: scale(0.8); opacity: 0.8; }
        100% { transform: scale(2.0); opacity: 0; }
      }
      .leaflet-popup-content-wrapper {
        background: #ffffff;
        color: #0f172a;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.18);
      }
      .leaflet-popup-tip {
        background: #ffffff;
      }
    `
    document.head.appendChild(style)

    return () => {
      const el = document.getElementById(styleId)
      if (el) el.remove()
    }
  }, [])

  // ─── Estilos de la ventana flotante ─────────────────────────────────────────
  let floatingStyle: React.CSSProperties = {}
  if (isFloating) {
    if (floatState.maximized) {
      floatingStyle = {
        position: 'fixed',
        inset: 0,
        zIndex: 9200,
      }
    } else {
      floatingStyle = {
        position: 'fixed',
        left: floatState.x,
        top: floatState.y,
        width: floatState.width,
        height: floatState.minimized ? TOOLBAR_H : floatState.height,
        zIndex: 9200,
      }
    }
  }

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── 1. Contenedor en el Layout Docked (cuando no está flotante) ── */}
      {!isFloating && (
        <div
          className={`relative flex flex-col bg-white border-l border-slate-200 transition-all duration-300 ease-in-out overflow-hidden ${
            isCollapsed ? 'w-10' : 'w-80'
          } ${className}`}
        >
          {/* Botón de colapsar/expandir en barra lateral */}
          <button
            type="button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? 'Expandir mapa global' : 'Colapsar mapa global'}
            className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 flex items-center justify-center size-6 rounded-full bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 hover:text-white shadow-lg transition-colors"
          >
            {isCollapsed ? <ChevronLeft className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>

          {/* Panel colapsado */}
          {isCollapsed ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 py-4 w-10">
              <Map className="size-4 text-slate-400" />
              <div
                className="text-[10px] text-slate-500 font-semibold tracking-widest"
                style={{ writingMode: 'vertical-rl', textOrientation: 'mixed', transform: 'rotate(180deg)' }}
              >
                MAPA SALA
              </div>
              {agentsWithGps.length > 0 && (
                <span className="size-4 rounded-full bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 text-[9px] flex items-center justify-center font-bold">
                  {agentsWithGps.length}
                </span>
              )}
            </div>
          ) : (
            /* Panel expandido normal */
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Cabecera del panel */}
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200 bg-slate-50 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Map className="size-3.5 text-blue-400 shrink-0" />
                  <span className="text-xs font-bold text-slate-800 truncate">Mapa Global</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Botón Flotar */}
                  <button
                    type="button"
                    onClick={() => {
                      setIsFloating(true)
                      setIsCollapsed(false)
                    }}
                    title="Hacer ventana flotante y ajustable"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-blue-300 hover:bg-blue-500/10 transition-colors"
                  >
                    <Pin className="size-3.5" />
                  </button>
                  {/* Botón Popout / 2do monitor */}
                  <button
                    type="button"
                    onClick={openExternalPopout}
                    title="Abrir en ventana externa (para otra pantalla o monitor)"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                  {/* Botón centrar todos */}
                  <button
                    type="button"
                    onClick={fitAllAgents}
                    disabled={agentsWithGps.length === 0}
                    title="Centrar todos los agentes"
                    className="flex items-center gap-1 px-2 py-1 rounded bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 text-[10px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <LocateFixed className="size-3" />
                    Todos
                  </button>
                </div>
              </div>

              {/* Contenedor del mapa */}
              <div className="flex-1 min-h-0 relative">
                <div ref={mapContainerRef} className="w-full h-full z-0" />

                {/* Overlays de estado */}
                {participants.length > 0 && agentsWithGps.length === 0 && (
                  <div className="absolute inset-0 z-10 bg-white/90 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center">
                    <Navigation className="size-8 text-blue-400 mb-2 animate-bounce" />
                    <p className="text-xs font-semibold text-slate-700">Sin señal GPS</p>
                    <p className="text-[10px] text-slate-400 mt-1 max-w-[200px]">
                      Los agentes aparecerán cuando transmitan coordenadas por DataChannel.
                    </p>
                  </div>
                )}
                {participants.length === 0 && (
                  <div className="absolute inset-0 z-10 bg-white/90 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center">
                    <Users className="size-8 text-slate-400 mb-2" />
                    <p className="text-xs text-slate-500">Sin agentes en sala</p>
                  </div>
                )}
              </div>

              {/* Leyenda de agentes */}
              {participants.length > 0 && (
                <div className="shrink-0 border-t border-slate-200 bg-slate-50 p-2 max-h-36 overflow-y-auto">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                    Agentes ({agentsWithGps.length}/{participants.length})
                  </p>
                  <ul className="flex flex-col gap-1">
                    {participants.map((p, idx) => {
                      const color = getAgentColor(idx)
                      const hasGps = typeof p.gps?.lat === 'number'
                      return (
                        <li key={p.identity} className="flex items-center gap-2">
                          <span
                            className="size-2.5 rounded-full shrink-0 border"
                            style={{ background: `${color}33`, borderColor: color }}
                          />
                          <span
                            className={`text-[11px] font-medium truncate flex-1 ${
                              p.isSpeaking ? 'text-blue-600' : 'text-slate-700'
                            }`}
                          >
                            {p.name}
                          </span>
                          {hasGps ? (
                            <span className="text-[9px] text-emerald-400 font-mono shrink-0">
                              {p.gps!.speed != null ? `${p.gps!.speed.toFixed(0)} km/h` : 'GPS ✓'}
                            </span>
                          ) : (
                            <span className="text-[9px] text-slate-600 shrink-0">Sin GPS</span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Placeholder en el dock cuando el mapa está flotante ── */}
      {isFloating && (
        <div className="w-14 bg-slate-900/60 border-l border-slate-800 flex flex-col items-center justify-center p-2 text-center gap-3">
          <Map className="size-5 text-blue-400 animate-pulse" />
          <span
            className="text-[10px] text-slate-400 font-semibold"
            style={{ writingMode: 'vertical-rl', textOrientation: 'mixed', transform: 'rotate(180deg)' }}
          >
            MAPA FLOTANTE
          </span>
          <button
            type="button"
            onClick={() => setIsFloating(false)}
            title="Re-acoplar mapa aquí"
            className="p-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 transition-colors"
          >
            <PinOff className="size-3.5" />
          </button>
        </div>
      )}

      {/* ── 2. Ventana Flotante / Redimensionable y Arrastrable ── */}
      {isFloating && (
        <div
          style={floatingStyle}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          className="flex flex-col rounded-2xl border border-blue-300/60 bg-white shadow-2xl shadow-black/20 overflow-hidden select-none"
        >
          {/* Barra de título de la ventana flotante (agarrar y mover) */}
          <div
            onPointerDown={(e) => drag.startDrag(e, 'move')}
            className="flex h-11 shrink-0 items-center justify-between px-3 bg-slate-950 border-b border-slate-800 cursor-grab active:cursor-grabbing select-none"
          >
            <div className="flex items-center gap-2 min-w-0">
              <GripVertical className="size-4 text-slate-500 shrink-0" />
              <Map className="size-4 text-blue-400 shrink-0" />
              <span className="truncate text-xs font-bold text-slate-100">
                Mapa Global de Sala
              </span>
              <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 text-[10px] font-medium border border-blue-500/30">
                {agentsWithGps.length}/{participants.length} GPS
              </span>
            </div>

            <div className="flex items-center gap-1">
              {/* Centrar todos */}
              <button
                type="button"
                onClick={fitAllAgents}
                disabled={agentsWithGps.length === 0}
                title="Centrar todos los agentes"
                className="flex items-center gap-1 px-2 py-1 rounded bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 text-[10px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed mr-1"
              >
                <LocateFixed className="size-3" />
                <span>Todos</span>
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
                title="Re-acoplar al panel lateral"
                className="p-1.5 rounded-lg text-slate-400 hover:text-blue-400 hover:bg-slate-800 transition-colors"
              >
                <PinOff className="size-3.5" />
              </button>
            </div>
          </div>

          {/* Contenido de la ventana flotante */}
          {!floatState.minimized && (
            <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
              {/* Mapa */}
              <div className="flex-1 min-h-0 relative">
                <div ref={mapContainerRef} className="w-full h-full z-0" />

                {participants.length > 0 && agentsWithGps.length === 0 && (
                  <div className="absolute inset-0 z-10 bg-white/90 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center">
                    <Navigation className="size-8 text-blue-400 mb-2 animate-bounce" />
                    <p className="text-xs font-semibold text-slate-700">Sin señal GPS</p>
                  </div>
                )}
              </div>

              {/* Leyenda inferior compacta */}
              {participants.length > 0 && (
                <div className="shrink-0 border-t border-slate-800 bg-slate-950/90 p-2 flex flex-wrap items-center gap-3 max-h-24 overflow-y-auto">
                  {participants.map((p, idx) => {
                    const color = getAgentColor(idx)
                    const hasGps = typeof p.gps?.lat === 'number'
                    return (
                      <div key={p.identity} className="flex items-center gap-1.5 text-xs">
                        <span
                          className="size-2 rounded-full shrink-0 border"
                          style={{ background: `${color}33`, borderColor: color }}
                        />
                        <span className="font-medium text-slate-200">{p.name}</span>
                        {hasGps && p.gps?.speed != null && (
                          <span className="text-[10px] text-emerald-400 font-mono">
                            {p.gps.speed.toFixed(1)} km/h
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

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
