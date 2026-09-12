'use client'

import { useEffect, useRef, useState } from 'react'
import { VideoOff, Volume2, MicOff, Signal, Loader2 } from 'lucide-react'
import type { HelmetParticipant } from '@/types/monitor'

interface ParticipantVideoProps {
  participant: HelmetParticipant
  isMaximized?: boolean
  isRecording?: boolean
  recordingTime?: string
}

export function ParticipantVideo({
  participant,
  isMaximized = false,
  isRecording = false,
  recordingTime = '00:00',
}: ParticipantVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    const videoEl = videoRef.current
    const track = participant.videoPublication?.track

    if (!videoEl) return

    // ── Forzar propiedades nativas del DOM para garantizar AUTOPLAY 100% ──
    videoEl.muted = true
    videoEl.defaultMuted = true
    videoEl.playsInline = true
    videoEl.setAttribute('muted', '')
    videoEl.setAttribute('playsinline', '')
    videoEl.setAttribute('autoplay', '')

    if (track) {
      try {
        track.attach(videoEl)

        const startPlayback = () => {
          videoEl.muted = true
          videoEl
            .play()
            .then(() => {
              setIsPlaying(true)
            })
            .catch((err) => {
              console.warn(`[Video] Reintentando autoplay con muted para ${participant.identity}:`, err)
              videoEl.muted = true
              videoEl.play().catch(() => {})
            })
        }

        videoEl.onloadedmetadata = startPlayback
        videoEl.oncanplay = startPlayback
        startPlayback()
      } catch (err) {
        console.error(`[Video] Error adjuntando track de video:`, err)
      }

      return () => {
        try {
          track.detach(videoEl)
        } catch (e) {}
        videoEl.onloadedmetadata = null
        videoEl.oncanplay = null
      }
    } else {
      setIsPlaying(false)
    }
  }, [participant.videoPublication, participant.videoPublication?.track, participant.identity])

  const hasTrack = Boolean(participant.videoPublication?.track)
  const isVideoVisible = hasTrack && !participant.isCameraOff

  return (
    <div className="relative w-full h-full bg-slate-950 flex items-center justify-center overflow-hidden select-none">
      {/* Elemento de video WebRTC */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`w-full h-full object-cover transition-opacity duration-300 ${
          isVideoVisible ? 'opacity-100' : 'opacity-0 absolute pointer-events-none'
        }`}
      />

      {/* Estado: Esperando o conectando video en vivo */}
      {!isVideoVisible && (
        <div className="flex flex-col items-center justify-center p-6 text-center z-10 select-none">
          <div className="relative mb-4">
            <div className="size-20 sm:size-24 rounded-2xl bg-gradient-to-br from-blue-900/60 to-slate-800/80 border border-blue-500/30 flex items-center justify-center text-2xl sm:text-3xl font-bold text-blue-300 shadow-xl backdrop-blur-md">
              {participant.initials}
            </div>
            {participant.isSpeaking && (
              <span className="absolute -inset-1 rounded-2xl border-2 border-emerald-400 animate-pulse pointer-events-none" />
            )}
          </div>
          <p className="text-sm font-semibold text-slate-200">{participant.name}</p>

          {participant.videoPublication ? (
            <span className="inline-flex items-center gap-1.5 mt-2 px-2.5 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-[11px] text-blue-300 animate-pulse">
              <Loader2 className="size-3 animate-spin" />
              Iniciando transmisión de video...
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 mt-2 px-2.5 py-0.5 rounded-full bg-slate-800/80 border border-slate-700/60 text-[11px] text-slate-400">
              <VideoOff className="size-3 text-slate-400" />
              Cámara en espera
            </span>
          )}
        </div>
      )}

      {/* Badges superiores: Nombre del agente y estado de audio */}
      <div className="absolute top-2.5 inset-x-2.5 flex items-center justify-between pointer-events-none z-20">
        <div className="flex items-center gap-2 bg-slate-900/85 backdrop-blur-md border border-slate-700/60 rounded-lg px-2.5 py-1 shadow-md">
          <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs font-semibold text-slate-100 max-w-[150px] truncate">
            {participant.name}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {isRecording && (
            <span className="flex items-center gap-1 bg-red-600 text-white font-bold px-2 py-0.5 rounded-full text-[10px] shadow-lg shadow-red-600/50 animate-pulse">
              <span className="size-1.5 rounded-full bg-white" />
              <span>REC {recordingTime}</span>
            </span>
          )}

          {participant.isSpeaking && (
            <span className="flex items-center gap-1 bg-emerald-500/90 text-slate-950 font-bold px-2 py-0.5 rounded-full text-[10px] shadow-md animate-pulse">
              <Signal className="size-3" />
              Hablando
            </span>
          )}
          <div className="bg-slate-900/85 backdrop-blur-md border border-slate-700/60 rounded-lg p-1.5 shadow-md">
            {participant.isAudioMuted ? (
              <MicOff className="size-3.5 text-red-400" />
            ) : (
              <Volume2 className="size-3.5 text-blue-400" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
