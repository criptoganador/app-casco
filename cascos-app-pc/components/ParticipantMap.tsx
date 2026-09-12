'use client'

import { useEffect, useRef, useState } from 'react'
import { Navigation, Gauge, Crosshair, Compass, Mountain, LocateFixed } from 'lucide-react'
import type { HelmetParticipant } from '@/types/monitor'

interface ParticipantMapProps {
  participant: HelmetParticipant
}

export function ParticipantMap({ participant }: ParticipantMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const polylineRef = useRef<any>(null)
  const [isMapReady, setIsMapReady] = useState(false)

  const gps = participant.gps
  const hasCoordinates = typeof gps?.lat === 'number' && typeof gps?.lng === 'number'

  // Inicializar Leaflet solo en el cliente
  useEffect(() => {
    let isMounted = true

    async function initMap() {
      if (typeof window === 'undefined' || !mapContainerRef.current || mapInstanceRef.current) return

      try {
        const L = (await import('leaflet')).default

        if (!isMounted || !mapContainerRef.current) return

        const initialLat = hasCoordinates ? gps.lat : 4.711
        const initialLng = hasCoordinates ? gps.lng : -74.072

        const map = L.map(mapContainerRef.current, {
          center: [initialLat, initialLng],
          zoom: hasCoordinates ? 16 : 13,
          zoomControl: false,
          attributionControl: false,
        })

        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 19,
          subdomains: 'abcd',
        }).addTo(map)

        // Trazado de ruta
        const routeLine = L.polyline(participant.routeHistory || [[initialLat, initialLng]], {
          color: '#3b82f6',
          weight: 4,
          opacity: 0.85,
          lineJoin: 'round',
        }).addTo(map)

        // Marcador personalizado con radar ping
        const helmetIcon = L.divIcon({
          className: 'custom-helmet-pin',
          html: `
            <div class="radar-ping"></div>
            <div class="helmet-marker-core">🪖</div>
          `,
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        })

        const marker = L.marker([initialLat, initialLng], { icon: helmetIcon }).addTo(map)
        marker.bindPopup(`<b>${participant.name}</b><br>Ubicación GPS en vivo`)

        mapInstanceRef.current = map
        markerRef.current = marker
        polylineRef.current = routeLine
        setIsMapReady(true)

        setTimeout(() => {
          map.invalidateSize()
        }, 300)
      } catch (err) {
        console.error('[Leaflet] Error inicializando mapa:', err)
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
        markerRef.current = null
        polylineRef.current = null
      }
    }
  }, []) // Solo al montar

  // Actualizar posición y polyline cuando llegan nuevas coordenadas
  useEffect(() => {
    if (!isMapReady || !mapInstanceRef.current || !hasCoordinates || !gps) return

    const latLng: [number, number] = [gps.lat, gps.lng]

    if (markerRef.current) {
      markerRef.current.setLatLng(latLng)
    }

    if (polylineRef.current) {
      polylineRef.current.setLatLngs(participant.routeHistory)
    }

    mapInstanceRef.current.panTo(latLng, { animate: true, duration: 0.8 })
  }, [gps?.lat, gps?.lng, participant.routeHistory, isMapReady, hasCoordinates])

  const centerMap = () => {
    if (mapInstanceRef.current && hasCoordinates && gps) {
      mapInstanceRef.current.setView([gps.lat, gps.lng], 17, { animate: true })
    }
  }

  return (
    <div className="relative w-full h-full flex flex-col bg-slate-950 overflow-hidden">
      {/* Contenedor Leaflet */}
      <div ref={mapContainerRef} className="w-full flex-1 z-0" />

      {/* Overlay si aún no hay coordenadas GPS */}
      {!hasCoordinates && (
        <div className="absolute inset-0 z-10 bg-slate-950/85 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center">
          <Navigation className="size-10 text-blue-400 mb-2 animate-bounce" />
          <p className="text-xs font-semibold text-slate-200">Esperando coordenadas GPS del celular...</p>
          <p className="text-[10px] text-slate-400 mt-1 max-w-[220px]">
            El mapa se posicionará y trazará la ruta cuando el casco transmita ubicación por WebRTC DataChannel.
          </p>
        </div>
      )}

      {/* Barra de telemetría compacta en la parte inferior */}
      <div className="z-10 bg-slate-900/95 border-t border-slate-800 p-2 text-xs flex flex-wrap items-center justify-between gap-1.5 shadow-lg">
        <div className="flex items-center gap-3">
          {/* Velocidad */}
          <div className="flex items-center gap-1 text-slate-300">
            <Gauge className="size-3.5 text-blue-400" />
            <span className="font-semibold text-slate-100">
              {typeof gps?.speed === 'number' ? gps.speed.toFixed(1) : '0.0'}
            </span>
            <span className="text-[10px] text-slate-400">km/h</span>
          </div>

          {/* Precisión */}
          <div className="flex items-center gap-1 text-slate-300">
            <Crosshair className="size-3.5 text-emerald-400" />
            <span className="font-semibold text-slate-100">
              {typeof gps?.accuracy === 'number' ? `±${gps.accuracy.toFixed(0)}m` : '--'}
            </span>
          </div>

          {/* Altitud */}
          <div className="hidden sm:flex items-center gap-1 text-slate-300">
            <Mountain className="size-3.5 text-amber-400" />
            <span className="font-semibold text-slate-100">
              {typeof gps?.altitude === 'number' && gps.altitude !== 0 ? `${gps.altitude.toFixed(0)}m` : '--'}
            </span>
          </div>

          {/* Rumbo */}
          <div className="hidden sm:flex items-center gap-1 text-slate-300">
            <Compass className="size-3.5 text-purple-400" />
            <span className="font-semibold text-slate-100">
              {typeof gps?.bearing === 'number' && gps.bearing !== 0 ? `${gps.bearing.toFixed(0)}°` : '--'}
            </span>
          </div>
        </div>

        {/* Coordenadas y botón centrar */}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[10px] text-slate-400 font-mono hidden md:inline">
            {hasCoordinates && gps ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : 'Sin señal'}
          </span>
          <button
            type="button"
            onClick={centerMap}
            disabled={!hasCoordinates}
            title="Centrar mapa en el casco"
            className="flex items-center gap-1 px-2 py-1 rounded bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <LocateFixed className="size-3" />
            <span>Centrar</span>
          </button>
        </div>
      </div>
    </div>
  )
}
