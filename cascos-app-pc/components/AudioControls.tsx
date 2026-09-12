'use client'

import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Volume2, VolumeX, Headphones, AlertCircle } from 'lucide-react'
import type { Room } from 'livekit-client'
import type { AudioInputDeviceInfo } from '@/types/monitor'

interface AudioControlsProps {
  room: Room | null
  isAudioUnlocked: boolean
  onUnlockAudio: () => void
}

export function AudioControls({ room, isAudioUnlocked, onUnlockAudio }: AudioControlsProps) {
  const [micEnabled, setMicEnabled] = useState(false)
  const [isMutedAll, setIsMutedAll] = useState(false)
  const [devices, setDevices] = useState<AudioInputDeviceInfo[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [isRequestingMic, setIsRequestingMic] = useState(false)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number | null>(null)
  const barsRef = useRef<HTMLDivElement[]>([])

  // Enumerar dispositivos de entrada de audio
  const loadDevices = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return
    try {
      const devList = await navigator.mediaDevices.enumerateDevices()
      const audioInputs = devList
        .filter((d) => d.kind === 'audioinput')
        .map((d, index) => ({
          deviceId: d.deviceId,
          label: d.label || `Micrófono ${index + 1}`,
        }))

      setDevices(audioInputs)

      // Auto-seleccionar headset o USB si está presente
      if (!selectedDevice && audioInputs.length > 0) {
        const preferred = audioInputs.find((d) => {
          const lower = d.label.toLowerCase()
          return (
            lower.includes('headset') ||
            lower.includes('usb') ||
            lower.includes('auricular') ||
            lower.includes('headphone')
          )
        })
        setSelectedDevice(preferred ? preferred.deviceId : audioInputs[0].deviceId)
      }
    } catch (e) {
      console.warn('[Audio] Error listando dispositivos de audio:', e)
    }
  }

  useEffect(() => {
    loadDevices()
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', loadDevices)
      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', loadDevices)
      }
    }
  }, [])

  // Iniciar medidor de volumen por AudioContext
  const startMicMeter = (track: MediaStreamTrack) => {
    stopMicMeter()
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      const ctx = new AudioCtx()
      const source = ctx.createMediaStreamSource(new MediaStream([track]))
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 64
      source.connect(analyser)

      audioCtxRef.current = ctx
      analyserRef.current = analyser

      const dataArray = new Uint8Array(analyser.frequencyBinCount)

      const update = () => {
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]
        const avg = sum / dataArray.length
        const scale = Math.min(2.4, Math.max(0.2, avg / 35 + 0.2))

        barsRef.current.forEach((bar, idx) => {
          if (bar) {
            bar.style.transform = `scaleY(${Math.min(2.4, scale * (1 + (idx % 2) * 0.25))})`
          }
        })

        animFrameRef.current = requestAnimationFrame(update)
      }

      update()
    } catch (e) {
      console.warn('[Audio] Error iniciando analizador de volumen:', e)
    }
  }

  const stopMicMeter = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close()
      } catch (e) {}
      audioCtxRef.current = null
    }
    barsRef.current.forEach((bar) => {
      if (bar) bar.style.transform = 'scaleY(0.25)'
    })
  }

  // Activar o desactivar micrófono local (PC → Celular)
  const toggleMic = async () => {
    if (!room) {
      alert('Conéctate a una sala para transmitir tu voz al casco.')
      return
    }

    setIsRequestingMic(true)

    try {
      const nextState = !micEnabled

      if (nextState) {
        // Publicar micrófono en LiveKit con supresión de eco y ruido
        const pub = await room.localParticipant.setMicrophoneEnabled(true, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId: selectedDevice ? { exact: selectedDevice } : undefined,
        })

        setMicEnabled(true)
        console.log('[Audio] Micrófono de PC activado:', pub)

        // Obtener MediaStreamTrack para el vúmetro
        const micTrack = (room.localParticipant.getTrackPublication as any)('microphone')?.track
        if (micTrack && (micTrack as any).mediaStreamTrack) {
          startMicMeter((micTrack as any).mediaStreamTrack)
        }

        await loadDevices()
      } else {
        stopMicMeter()
        await room.localParticipant.setMicrophoneEnabled(false)
        setMicEnabled(false)
        console.log('[Audio] Micrófono de PC silenciado')
      }
    } catch (err: any) {
      stopMicMeter()
      setMicEnabled(false)
      console.error('[Audio] Error con micrófono:', err)
      alert('Error activando el micrófono: ' + (err.message || err))
    } finally {
      setIsRequestingMic(false)
    }
  }

  // Cambiar dispositivo de entrada de micrófono
  const handleDeviceChange = async (newDeviceId: string) => {
    setSelectedDevice(newDeviceId)
    if (room && micEnabled) {
      try {
        await room.switchActiveDevice('audioinput', newDeviceId)
        console.log('[Audio] Dispositivo cambiado a:', newDeviceId)
      } catch (e) {
        console.warn('[Audio] Error cambiando dispositivo:', e)
      }
    }
  }

  // Silenciar/desmutear audio entrante de los cascos
  const toggleMuteAll = () => {
    const nextMute = !isMutedAll
    setIsMutedAll(nextMute)

    const audios = document.querySelectorAll('audio')
    audios.forEach((el) => {
      el.muted = nextMute
    })
  }

  return (
    <div className="flex items-center gap-2">
      {/* Botón de desbloqueo de audio si el navegador lo bloqueó */}
      {!isAudioUnlocked && (
        <button
          type="button"
          onClick={onUnlockAudio}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs font-semibold animate-pulse shadow-lg"
        >
          <AlertCircle className="size-3.5" />
          <span>Desbloquear Audio</span>
        </button>
      )}

      {/* Selector de micrófono USB/Headset */}
      <div className="hidden xl:flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1 text-xs">
        <Headphones className="size-3.5 text-blue-400 shrink-0" />
        <select
          value={selectedDevice}
          onChange={(e) => handleDeviceChange(e.target.value)}
          className="bg-transparent text-slate-200 text-xs outline-none cursor-pointer max-w-[140px] truncate"
        >
          {devices.length === 0 ? (
            <option value="">🎤 Micrófono por defecto</option>
          ) : (
            devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId} className="bg-slate-900 text-slate-100">
                {d.label}
              </option>
            ))
          )}
        </select>
      </div>

      {/* Botón de Hablar (Micrófono PC → Celular) */}
      <button
        type="button"
        onClick={toggleMic}
        disabled={isRequestingMic}
        title={micEnabled ? 'Silenciar mi micrófono' : 'Hablar hacia el casco'}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shadow-md ${
          micEnabled
            ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/30'
            : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
        }`}
      >
        {micEnabled ? (
          <>
            {/* Barras de ecualizador animadas */}
            <div className="mic-bars">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  ref={(el) => {
                    if (el) barsRef.current[i] = el
                  }}
                  className="mic-bar"
                />
              ))}
            </div>
            <span>Hablando</span>
          </>
        ) : (
          <>
            <Mic className="size-3.5 text-slate-300" />
            <span>Hablar</span>
          </>
        )}
      </button>

      {/* Botón de silenciar/activar altavoces (Audio recibido) */}
      <button
        type="button"
        onClick={toggleMuteAll}
        title={isMutedAll ? 'Reactivar audio de cascos' : 'Silenciar audio de cascos'}
        className={`p-2 rounded-lg border text-xs transition-colors ${
          isMutedAll
            ? 'bg-red-500/20 text-red-400 border-red-500/30'
            : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
        }`}
      >
        {isMutedAll ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
    </div>
  )
}
