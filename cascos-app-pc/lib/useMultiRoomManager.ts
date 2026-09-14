'use client'

import { useRef, useState, useCallback } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type TrackPublication,
} from 'livekit-client'
import { LIVEKIT_CONFIG } from './livekit-config'
import { createViewerToken } from './livekit-token'
import type { HelmetParticipant, GpsTelemetry, WindowState } from '@/types/monitor'

// ─────────────────────────────────────────────────────────────────────────────
// Hook: useMultiRoomManager
//
// Arquitectura Opción B (sala por agente):
//   - Cada casco se conecta a su propia sala LiveKit individual.
//   - La PC crea UNA Room de LiveKit POR CADA sala activa detectada.
//   - El micrófono del operador se publica en TODAS las salas simultáneamente.
//   - Ahorro: cada casco solo recibe audio del operador, no video de otros cascos.
// ─────────────────────────────────────────────────────────────────────────────
export function useMultiRoomManager() {
  // Map<roomName, Room> — una conexión LiveKit por sala
  const roomsRef = useRef<Map<string, Room>>(new Map())
  // Salas en proceso de conexión (evitar dobles conexiones)
  const connectingRoomsRef = useRef<Set<string>>(new Set())
  // Map<participantIdentity, HTMLAudioElement> — audios remotos activos
  const attachedAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const pendingAudioRef = useRef<HTMLAudioElement[]>([])
  // Estado del micrófono y dispositivo seleccionado (refs para evitar stale closures)
  const micEnabledRef = useRef(false)
  const selectedDeviceRef = useRef('')

  // Estado React (UI)
  const [connectedRoomNames, setConnectedRoomNames] = useState<string[]>([])
  const [participants, setParticipants] = useState<HelmetParticipant[]>([])
  const [windows, setWindows] = useState<Record<string, WindowState>>({})
  const [highestZ, setHighestZ] = useState(10)
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(true)
  const [micEnabled, setMicEnabled] = useState(false)

  // ─── Audio: adjuntar track remoto de un casco ───────────────────────────────
  const attachRemoteAudio = useCallback((track: any, participantIdentity: string) => {
    if (!track || !participantIdentity || participantIdentity.startsWith('monitor-pc-')) return
    const existing = attachedAudiosRef.current.get(participantIdentity)
    if (existing) {
      existing.volume = 1.0
      existing.play().catch(() => {})
      return
    }
    try {
      const audioEl = track.attach() as HTMLAudioElement
      audioEl.id = `lk-audio-${participantIdentity}`
      audioEl.style.display = 'none'
      audioEl.autoplay = true
      audioEl.volume = 1.0
      document.body.appendChild(audioEl)
      attachedAudiosRef.current.set(participantIdentity, audioEl)
      audioEl
        .play()
        .then(() => {
          setIsAudioUnlocked(true)
          console.log(`[MultiRoom] 🔊 Audio de ${participantIdentity} reproduciendo.`)
        })
        .catch(() => {
          setIsAudioUnlocked(false)
          pendingAudioRef.current.push(audioEl)
        })
    } catch (err) {
      console.error(`[MultiRoom] Error adjuntando audio de ${participantIdentity}:`, err)
    }
  }, [])

  // ─── Audio: desconectar track remoto ────────────────────────────────────────
  const detachRemoteAudio = useCallback((identity: string) => {
    const audioEl = attachedAudiosRef.current.get(identity)
    if (audioEl) {
      try { audioEl.pause(); audioEl.remove() } catch (e) {}
      attachedAudiosRef.current.delete(identity)
    }
  }, [])

  // ─── Desbloquear audio pendiente (autoplay policy del navegador) ─────────────
  const unlockAudioManually = useCallback(() => {
    setIsAudioUnlocked(true)
    pendingAudioRef.current.forEach((el) => {
      el.muted = false
      el.play().catch(() => {})
    })
    pendingAudioRef.current = []
  }, [])

  // ─── Actualizar campos de un participante ───────────────────────────────────
  const updateParticipant = useCallback((identity: string, patch: Partial<HelmetParticipant>) => {
    setParticipants((prev) =>
      prev.map((p) => (p.identity === identity ? { ...p, ...patch } : p))
    )
  }, [])

  // ─── Participante se une o actualiza tracks ──────────────────────────────────
  const handleParticipantJoined = useCallback(
    (roomName: string, rp: RemoteParticipant) => {
      if (!rp || !rp.identity || rp.identity.startsWith('monitor-pc-')) return
      const identity = rp.identity
      const name = identity.replace(/^casco-/, '').replace(/-/g, ' ')
      const initials =
        name.split(' ').slice(0, 2).map((s: string) => s[0]?.toUpperCase() || '').join('') || 'C'

      let videoPub: TrackPublication | undefined
      let audioPub: TrackPublication | undefined

      rp.trackPublications.forEach((pub) => {
        if (pub.kind === Track.Kind.Video) {
          videoPub = pub
          if (!pub.isSubscribed) pub.setSubscribed(true)
        } else if (pub.kind === Track.Kind.Audio) {
          audioPub = pub
          if (!pub.isSubscribed) pub.setSubscribed(true)
          if (pub.track) attachRemoteAudio(pub.track, identity)
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
                  roomName,
                }
              : p
          )
        }
        const newP: HelmetParticipant = {
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
          roomName,
        }
        return [...prev, newP]
      })

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

  // ─── Participante sale de una sala ───────────────────────────────────────────
  const handleParticipantLeft = useCallback(
    (roomName: string, identity: string) => {
      detachRemoteAudio(identity)
      setParticipants((prev) => prev.filter((p) => p.identity !== identity))
      setWindows((prev) => {
        const next = { ...prev }
        delete next[identity]
        return next
      })
    },
    [detachRemoteAudio]
  )

  // ─── Telemetría GPS por DataChannel ─────────────────────────────────────────
  const handleGpsReceived = useCallback((identity: string, data: GpsTelemetry) => {
    setParticipants((prev) =>
      prev.map((p) => {
        if (p.identity !== identity) return p
        const latLng: [number, number] = [data.lat, data.lng]
        const history = [...p.routeHistory, latLng]
        if (history.length > 500) history.shift()
        return { ...p, gps: data, routeHistory: history, lastGpsUpdate: Date.now() }
      })
    )
  }, [])

  // ─── Conectar a UNA sala LiveKit ─────────────────────────────────────────────
  const connectToRoom = useCallback(
    async (roomName: string) => {
      if (roomsRef.current.has(roomName) || connectingRoomsRef.current.has(roomName)) return
      connectingRoomsRef.current.add(roomName)
      console.log(`[MultiRoom] 🔌 Conectando a sala "${roomName}"...`)

      try {
        const token = await createViewerToken(roomName)
        const lkRoom = new Room({ adaptiveStream: true, dynacast: true })

        lkRoom.on(RoomEvent.ParticipantConnected, (rp: RemoteParticipant) => {
          if (!rp.identity.startsWith('monitor-pc-')) handleParticipantJoined(roomName, rp)
        })

        lkRoom.on(RoomEvent.ParticipantDisconnected, (rp: RemoteParticipant) => {
          handleParticipantLeft(roomName, rp.identity)
        })

        lkRoom.on(RoomEvent.TrackPublished, (publication, participant) => {
          if (participant.identity.startsWith('monitor-pc-')) return
          publication.setSubscribed(true)
          handleParticipantJoined(roomName, participant as RemoteParticipant)
          if (publication.kind === Track.Kind.Video) {
            updateParticipant(participant.identity, { hasVideoTrack: true, isCameraOff: false, videoPublication: publication })
          } else if (publication.kind === Track.Kind.Audio) {
            updateParticipant(participant.identity, { hasAudioTrack: true, isAudioMuted: false, audioPublication: publication })
          }
        })

        lkRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (participant.identity.startsWith('monitor-pc-')) return
          handleParticipantJoined(roomName, participant as RemoteParticipant)
          if (track.kind === Track.Kind.Video || (track.kind as string) === 'video') {
            updateParticipant(participant.identity, { hasVideoTrack: true, isCameraOff: false, videoPublication: publication })
          } else if (track.kind === Track.Kind.Audio || (track.kind as string) === 'audio') {
            attachRemoteAudio(track, participant.identity)
            updateParticipant(participant.identity, { hasAudioTrack: true, isAudioMuted: false, audioPublication: publication })
          }
        })

        lkRoom.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
          if (track.kind === Track.Kind.Video || (track.kind as string) === 'video') {
            updateParticipant(participant.identity, { hasVideoTrack: false, isCameraOff: true })
          } else if (track.kind === Track.Kind.Audio || (track.kind as string) === 'audio') {
            detachRemoteAudio(participant.identity)
            updateParticipant(participant.identity, { hasAudioTrack: false, isAudioMuted: true })
          }
        })

        lkRoom.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
          if ((topic === 'location' || topic === 'gps') && participant) {
            try {
              const data = JSON.parse(new TextDecoder().decode(payload))
              if (typeof data.lat === 'number' && typeof data.lng === 'number') {
                handleParticipantJoined(roomName, participant as RemoteParticipant)
                handleGpsReceived(participant.identity, data)
              }
            } catch (err) {
              console.warn('[MultiRoom] Error procesando GPS:', err)
            }
          }
        })

        lkRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const speakingIds = new Set(speakers.map((s) => s.identity))
          setParticipants((prev) => prev.map((p) => ({ ...p, isSpeaking: speakingIds.has(p.identity) })))
        })

        lkRoom.on(RoomEvent.Disconnected, () => {
          console.log(`[MultiRoom] ⚡ Sala "${roomName}" desconectada.`)
          roomsRef.current.delete(roomName)
          connectingRoomsRef.current.delete(roomName)
          setConnectedRoomNames((prev) => prev.filter((n) => n !== roomName))
          setParticipants((prev) => {
            prev.filter((p) => p.roomName === roomName).forEach((p) => detachRemoteAudio(p.identity))
            return prev.filter((p) => p.roomName !== roomName)
          })
        })

        await lkRoom.connect(LIVEKIT_CONFIG.wsUrl, token, { autoSubscribe: true })
        roomsRef.current.set(roomName, lkRoom)
        connectingRoomsRef.current.delete(roomName)
        setConnectedRoomNames((prev) => (prev.includes(roomName) ? prev : [...prev, roomName]))
        console.log(`[MultiRoom] ✅ Conectado a sala "${roomName}"`)

        // Participantes ya presentes al conectar
        lkRoom.remoteParticipants.forEach((rp) => {
          if (!rp.identity.startsWith('monitor-pc-')) {
            handleParticipantJoined(roomName, rp)
            rp.trackPublications.forEach((pub) => { if (!pub.isSubscribed) pub.setSubscribed(true) })
          }
        })

        // Si el mic del operador ya estaba activo, publicarlo en esta nueva sala
        if (micEnabledRef.current) {
          try {
            await lkRoom.localParticipant.setMicrophoneEnabled(true, {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              ...(selectedDeviceRef.current ? { deviceId: { exact: selectedDeviceRef.current } } : {}),
            })
            console.log(`[MultiRoom] 🎤 Micrófono publicado en sala "${roomName}" (ya activo).`)
          } catch (e) {
            console.warn(`[MultiRoom] Error activando mic en "${roomName}":`, e)
          }
        }
      } catch (err: any) {
        connectingRoomsRef.current.delete(roomName)
        console.error(`[MultiRoom] ❌ Error conectando a "${roomName}":`, err)
      }
    },
    [handleParticipantJoined, handleParticipantLeft, handleGpsReceived, attachRemoteAudio, detachRemoteAudio, updateParticipant]
  )

  // ─── Desconectar de una sala específica ─────────────────────────────────────
  const disconnectRoom = useCallback(async (roomName: string) => {
    const lkRoom = roomsRef.current.get(roomName)
    if (!lkRoom) return
    try { await lkRoom.disconnect() } catch (e) {}
    // RoomEvent.Disconnected limpia el state automáticamente
  }, [])

  // ─── Sincronizar lista de salas activas (add nuevas, remove desaparecidas) ───
  const syncRooms = useCallback(
    async (activeRoomNames: string[]) => {
      // 1. Conectar a salas nuevas
      for (const name of activeRoomNames) {
        if (!roomsRef.current.has(name) && !connectingRoomsRef.current.has(name)) {
          connectToRoom(name)
        }
      }
      // 2. Desconectar salas que ya no aparecen como activas
      for (const [name] of roomsRef.current) {
        if (!activeRoomNames.includes(name)) {
          console.log(`[MultiRoom] Sala "${name}" no está en lista activa. Desconectando...`)
          disconnectRoom(name)
        }
      }
    },
    [connectToRoom, disconnectRoom]
  )

  // ─── Desconectar de TODAS las salas ─────────────────────────────────────────
  const disconnectAll = useCallback(async () => {
    await Promise.allSettled([...roomsRef.current.keys()].map((name) => disconnectRoom(name)))
    attachedAudiosRef.current.forEach((el) => {
      try { el.pause(); el.remove() } catch (e) {}
    })
    attachedAudiosRef.current.clear()
    pendingAudioRef.current = []
    setParticipants([])
    setWindows({})
    setConnectedRoomNames([])
  }, [disconnectRoom])

  // ─── Toggle micrófono en TODAS las salas activas ────────────────────────────
  const toggleMic = useCallback(async (deviceId?: string): Promise<boolean> => {
    const nextEnabled = !micEnabledRef.current
    if (deviceId) selectedDeviceRef.current = deviceId
    const constraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(selectedDeviceRef.current ? { deviceId: { exact: selectedDeviceRef.current } } : {}),
    }
    await Promise.allSettled(
      [...roomsRef.current.values()].map(async (lkRoom) => {
        try {
          await lkRoom.localParticipant.setMicrophoneEnabled(nextEnabled, nextEnabled ? constraints : undefined)
        } catch (e) {
          console.warn(`[MultiRoom] Error toggling mic:`, e)
        }
      })
    )
    micEnabledRef.current = nextEnabled
    setMicEnabled(nextEnabled)
    console.log(`[MultiRoom] 🎤 Micrófono ${nextEnabled ? 'ACTIVO' : 'SILENCIADO'} en ${roomsRef.current.size} sala(s).`)
    return nextEnabled
  }, [])

  // ─── Cambiar dispositivo de micrófono en todas las salas ───────────────────
  const changeAudioDevice = useCallback(async (newDeviceId: string) => {
    selectedDeviceRef.current = newDeviceId
    if (!micEnabledRef.current) return
    await Promise.allSettled(
      [...roomsRef.current.values()].map(async (lkRoom) => {
        try { await lkRoom.switchActiveDevice('audioinput', newDeviceId) } catch (e) {}
      })
    )
  }, [])

  // ─── Traer ventana al frente ─────────────────────────────────────────────────
  const bringToFront = useCallback((identity: string) => {
    setHighestZ((prev) => {
      const nextZ = prev + 1
      setWindows((w) => ({ ...w, [identity]: { ...w[identity], z: nextZ } }))
      return nextZ
    })
  }, [])

  // ─── Actualizar posición/tamaño de ventana ──────────────────────────────────
  const updateWindowState = useCallback((identity: string, patch: Partial<WindowState>) => {
    setWindows((prev) => ({ ...prev, [identity]: { ...prev[identity], ...patch } }))
  }, [])

  // ─── Obtener snapshot del Map de rooms para AudioControls ──────────────────
  const getRooms = useCallback((): Room[] => [...roomsRef.current.values()], [])

  // ─── Obtener Room específica por nombre de sala ─────────────────────────────
  const getRoomByName = useCallback((name?: string): Room | undefined => {
    return name ? roomsRef.current.get(name) : undefined
  }, [])

  return {
    // Estado
    participants,
    windows,
    connectedRoomNames,
    isAnyConnected: connectedRoomNames.length > 0,
    isAudioUnlocked,
    micEnabled,
    highestZ,

    // Métodos de sala
    syncRooms,
    disconnectAll,

    // Métodos de audio
    toggleMic,
    changeAudioDevice,
    unlockAudioManually,
    getRooms,
    getRoomByName,

    // Métodos de UI / ventanas
    bringToFront,
    updateWindowState,
    updateParticipant,
  }
}
