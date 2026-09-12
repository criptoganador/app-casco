'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type { Room } from 'livekit-client'
import { Track } from 'livekit-client'
import type { HelmetParticipant } from '@/types/monitor'

export interface AgentRecorderState {
  isRecording: boolean
  duration: number
  formattedTime: string
  startRecording: () => Promise<boolean>
  stopRecording: () => Promise<void>
}

/**
 * Guarda el archivo grabado permitiendo al operador elegir la carpeta y nombre de destino.
 */
export async function saveRecordingFile(blob: Blob, agentName: string) {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
    now.getHours()
  )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const cleanName = agentName.trim().replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ_-]/g, '_')
  const defaultFilename = `Grabacion_${cleanName}_${dateStr}.webm`

  // 1. Probar File System Access API nativa (Abre el diálogo nativo de Windows "Guardar como...")
  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: defaultFilename,
        types: [
          {
            description: 'Video WebM con Audio (*.webm)',
            accept: { 'video/webm': ['.webm'] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[Recorder] El operador canceló el diálogo de guardado')
        return
      }
      console.warn('[Recorder] showSaveFilePicker no disponible o falló, usando fallback:', err)
    }
  }

  // 2. Fallback estándar para navegadores sin showSaveFilePicker
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = defaultFilename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 1000)
}

export function useAgentRecorder(
  participant: HelmetParticipant,
  room?: Room | null
): AgentRecorderState {
  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)

  // Formato mm:ss
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, '0')
    const s = (secs % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  // ── Detener grabación y guardar archivo ──
  const stopRecording = useCallback(async () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      setIsRecording(false)
      return
    }

    // Detener el timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }

    const rec = mediaRecorderRef.current

    return new Promise<void>((resolve) => {
      rec.onstop = async () => {
        try {
          const mimeType = rec.mimeType || 'video/webm'
          const finalBlob = new Blob(recordedChunksRef.current, { type: mimeType })
          recordedChunksRef.current = []

          // Cerrar AudioContext si se creó para mezclar audios
          if (audioContextRef.current) {
            try {
              audioContextRef.current.close()
            } catch (_) {}
            audioContextRef.current = null
          }

          setIsRecording(false)
          setDuration(0)

          if (finalBlob.size > 0) {
            await saveRecordingFile(finalBlob, participant.name)
          }
        } catch (e) {
          console.error('[Recorder] Error procesando archivo de grabación:', e)
        } finally {
          resolve()
        }
      }

      rec.stop()
    })
  }, [participant.name])

  // ── Iniciar grabación ──
  const startRecording = useCallback(async (): Promise<boolean> => {
    try {
      // 1. Obtener pista de video del casco
      const videoTrack = (participant.videoPublication?.track as any)?.mediaStreamTrack as
        | MediaStreamTrack
        | undefined

      if (!videoTrack) {
        alert('El casco aún no tiene video activo para grabar. Espera a que inicie la imagen.')
        return false
      }

      // 2. Obtener pista de audio del casco
      const remoteAudioTrack = (participant.audioPublication?.track as any)?.mediaStreamTrack as
        | MediaStreamTrack
        | undefined

      // 3. Obtener micrófono local de la PC (si el operador está hablando en la llamada)
      const localMicPublication = room?.localParticipant?.getTrackPublication(Track.Source.Microphone)
      const localMicTrack = (localMicPublication?.track as any)?.mediaStreamTrack as
        | MediaStreamTrack
        | undefined

      // 4. Crear o mezclar pistas de audio
      let finalAudioTrack: MediaStreamTrack | null = null

      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
        const ctx = new AudioCtx()
        audioContextRef.current = ctx
        const dest = ctx.createMediaStreamDestination()
        let hasAudioSource = false

        if (remoteAudioTrack && remoteAudioTrack.readyState === 'live') {
          const srcRemote = ctx.createMediaStreamSource(new MediaStream([remoteAudioTrack]))
          srcRemote.connect(dest)
          hasAudioSource = true
        }

        if (localMicTrack && localMicTrack.readyState === 'live') {
          const srcLocal = ctx.createMediaStreamSource(new MediaStream([localMicTrack]))
          srcLocal.connect(dest)
          hasAudioSource = true
        }

        if (hasAudioSource && dest.stream.getAudioTracks().length > 0) {
          finalAudioTrack = dest.stream.getAudioTracks()[0]
        }
      } catch (e) {
        console.warn('[Recorder] No se pudo mezclar audio con WebAudio, usando directo:', e)
        finalAudioTrack = remoteAudioTrack || localMicTrack || null
      }

      // 5. Ensamblar MediaStream compuesto (Video + Audio mezclado)
      const combinedTracks: MediaStreamTrack[] = [videoTrack]
      if (finalAudioTrack) {
        combinedTracks.push(finalAudioTrack)
      } else if (remoteAudioTrack) {
        combinedTracks.push(remoteAudioTrack)
      }

      const streamToRecord = new MediaStream(combinedTracks)

      // 6. Seleccionar códec soportado
      let mimeType = 'video/webm;codecs=vp9,opus'
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm;codecs=vp8,opus'
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'video/webm'
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'video/mp4'
          }
        }
      }

      const recorder = new MediaRecorder(streamToRecord, {
        mimeType,
        videoBitsPerSecond: 2500000, // 2.5 Mbps de alta calidad
      })

      recordedChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data)
        }
      }

      recorder.start(1000) // Trozos de 1 segundo para asegurar fluidez
      mediaRecorderRef.current = recorder

      setIsRecording(true)
      setDuration(0)

      // Iniciar contador
      timerIntervalRef.current = setInterval(() => {
        setDuration((prev) => prev + 1)
      }, 1000)

      return true
    } catch (err) {
      console.error('[Recorder] Error iniciando grabación:', err)
      alert('Error iniciando la grabación de video: ' + (err as any)?.message)
      return false
    }
  }, [participant.videoPublication?.track, participant.audioPublication?.track, room])

  // Si el componente se desmonta o el participante se sale mientras graba, guardar automáticamente
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        stopRecording()
      }
    }
  }, [stopRecording])

  return {
    isRecording,
    duration,
    formattedTime: formatTime(duration),
    startRecording,
    stopRecording,
  }
}
