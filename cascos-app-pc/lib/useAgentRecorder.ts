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
 * Notificación visual tipo Toast cuando se guarda una grabación (especialmente útil en autoguardado).
 */
function showAutoSaveNotification(filename: string, agentName: string, isAuto: boolean) {
  if (typeof document === 'undefined') return
  const toastId = 'recorder-toast-container'
  let toastContainer = document.getElementById(toastId)
  if (!toastContainer) {
    toastContainer = document.createElement('div')
    toastContainer.id = toastId
    toastContainer.className = 'fixed bottom-5 right-5 z-[99999] flex flex-col gap-2 pointer-events-none'
    document.body.appendChild(toastContainer)
  }

  const toast = document.createElement('div')
  toast.className =
    'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-900/95 border border-emerald-500/40 text-slate-100 shadow-2xl backdrop-blur transition-all transform duration-300 translate-y-2 opacity-0'
  toast.innerHTML = `
    <div class="size-9 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
      <svg xmlns="http://www.w3.org/2000/svg" class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
    </div>
    <div class="min-w-0 pr-2">
      <div class="text-xs font-bold text-emerald-400">
        ${isAuto ? 'Grabación guardada al finalizar llamada' : 'Grabación guardada con éxito'}
      </div>
      <div class="text-[11px] text-slate-300 truncate max-w-xs" title="${filename}">
        ${filename}
      </div>
      <div class="text-[10px] text-slate-400">Agente: ${agentName}</div>
    </div>
  `
  toastContainer.appendChild(toast)

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0')
  })

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2')
    setTimeout(() => {
      toast.remove()
    }, 400)
  }, 6000)
}

/**
 * Guarda el archivo grabado en el sistema de archivos.
 * - Si es guardado manual (clic del operador en "Guardar"): intenta abrir el diálogo nativo de Windows "Guardar como...".
 * - Si es guardado automático (el agente colgó o desconectó USB sin haber dado guardar): descarga directa automática inmediata sin perder datos.
 */
export async function saveRecordingFile(blob: Blob, agentName: string, isAuto = false) {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
    now.getHours()
  )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const cleanName = (agentName || 'Agente').trim().replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ_-]/g, '_')
  const defaultFilename = `Grabacion_${cleanName}_${dateStr}.webm`

  // 1. Si es guardado manual y el navegador soporta showSaveFilePicker, abrir diálogo nativo de Windows
  if (!isAuto && typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
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
      showAutoSaveNotification(defaultFilename, cleanName, false)
      return
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[Recorder] El operador canceló el diálogo de guardado')
        return
      }
      console.warn('[Recorder] showSaveFilePicker no disponible o sin gesto activo, usando descarga directa:', err)
    }
  }

  // 2. Descarga directa automática / Fallback
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = defaultFilename
  document.body.appendChild(a)
  a.click()
  showAutoSaveNotification(defaultFilename, cleanName, isAuto)

  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 4000)
}

export function useAgentRecorder(
  participant: HelmetParticipant,
  room?: Room | null
): AgentRecorderState {
  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const isRecordingRef = useRef(false)
  const hasSavedRef = useRef(false)
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const participantNameRef = useRef(participant.name)

  // Mantener nombre de participante siempre actualizado
  useEffect(() => {
    participantNameRef.current = participant.name
  }, [participant.name])

  // Formato mm:ss
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, '0')
    const s = (secs % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  // ── Finalizar y guardar grabación (a prueba de fallos y desconexiones) ──
  const finalizeAndSave = useCallback(async (reason: 'manual' | 'auto') => {
    // Evitar guardar dos veces la misma sesión
    if (hasSavedRef.current) return
    if (!isRecordingRef.current && recordedChunksRef.current.length === 0) return

    hasSavedRef.current = true
    isRecordingRef.current = false

    // Detener el timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }

    const rec = mediaRecorderRef.current

    // Forzar solicitud de cualquier fragmento de video pendiente y detener
    if (rec && rec.state !== 'inactive') {
      try {
        rec.requestData()
      } catch (_) {}
      try {
        rec.stop()
      } catch (_) {}
    }

    // Cerrar AudioContext si se abrió para mezclar audios
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close()
      } catch (_) {}
      audioContextRef.current = null
    }

    setIsRecording(false)
    setDuration(0)

    // Pequeña pausa para asegurar que el último fragmento entre a recordedChunksRef
    await new Promise((r) => setTimeout(r, 120))

    const chunks = [...recordedChunksRef.current]
    recordedChunksRef.current = []

    if (chunks.length === 0) {
      console.warn('[Recorder] No hubo datos suficientes para generar archivo de video')
      return
    }

    try {
      const mimeType = rec?.mimeType || 'video/webm'
      const finalBlob = new Blob(chunks, { type: mimeType })

      if (finalBlob.size > 0) {
        console.log(
          `[Recorder] Guardando grabación de ${participantNameRef.current} (${(
            finalBlob.size /
            1024 /
            1024
          ).toFixed(2)} MB, motivo: ${reason})`
        )
        await saveRecordingFile(finalBlob, participantNameRef.current, reason === 'auto')
      }
    } catch (e) {
      console.error('[Recorder] Error procesando archivo de grabación:', e)
    }
  }, [])

  // ── Detener grabación manual por el operador ──
  const stopRecording = useCallback(async () => {
    await finalizeAndSave('manual')
  }, [finalizeAndSave])

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

      // 3. Obtener micrófono local de la PC (si el operador está hablando en la sala del casco)
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
        videoBitsPerSecond: 2500000, // 2.5 Mbps
      })

      // Reiniciar flags y chunks
      recordedChunksRef.current = []
      hasSavedRef.current = false
      isRecordingRef.current = true

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data)
        }
      }

      // Si el recorder emite stop naturalmente (por finalización de tracks)
      recorder.onstop = () => {
        finalizeAndSave('auto')
      }

      // Si la pista de video remota se corta (agente colgó o desconectó cámara)
      videoTrack.addEventListener(
        'ended',
        () => {
          console.log('[Recorder] Video track finalizó, autoguardando grabación...')
          finalizeAndSave('auto')
        },
        { once: true }
      )

      if (remoteAudioTrack) {
        remoteAudioTrack.addEventListener(
          'ended',
          () => {
            console.log('[Recorder] Audio track finalizó, autoguardando grabación...')
            finalizeAndSave('auto')
          },
          { once: true }
        )
      }

      recorder.start(1000) // Trozos de 1 segundo
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
  }, [participant.videoPublication?.track, participant.audioPublication?.track, room, finalizeAndSave])

  // Si el componente se desmonta (agente salió de la sala, llamada finalizó, o usuario cerró ventana)
  // mientras se estaba grabando: GUARDAR AUTOMÁTICAMENTE LO QUE SE ALCANZÓ A GRABAR
  useEffect(() => {
    return () => {
      if (isRecordingRef.current || recordedChunksRef.current.length > 0) {
        console.log(
          `[Recorder] Desmontaje de ventana detectado con grabación activa (${participantNameRef.current}). Autoguardando...`
        )
        finalizeAndSave('auto')
      }
    }
  }, [finalizeAndSave])

  return {
    isRecording,
    duration,
    formattedTime: formatTime(duration),
    startRecording,
    stopRecording,
  }
}
