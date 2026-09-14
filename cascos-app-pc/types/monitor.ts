import type { TrackPublication, RemoteParticipant, LocalParticipant } from 'livekit-client'

export interface GpsTelemetry {
  lat: number
  lng: number
  speed?: number
  accuracy?: number
  altitude?: number
  bearing?: number
  time?: number
}

export interface HelmetParticipant {
  id: string
  identity: string
  name: string
  initials: string
  isLocal: boolean
  isSpeaking: boolean
  hasVideoTrack: boolean
  hasAudioTrack: boolean
  isCameraOff: boolean
  isAudioMuted: boolean
  videoPublication?: TrackPublication
  audioPublication?: TrackPublication
  gps?: GpsTelemetry
  routeHistory: [number, number][]
  lastGpsUpdate?: number
  participantInstance?: RemoteParticipant | LocalParticipant
  /** Nombre de la sala LiveKit a la que pertenece este agente (arquitectura multi-room) */
  roomName?: string
}

export interface WindowState {
  id: string
  x: number
  y: number
  width: number
  height: number
  floating: boolean
  minimized: boolean
  maximized: boolean
  z: number
}

export interface RoomSummary {
  name: string
  numParticipants: number
  numPublishers: number
  isLive: boolean
}

export type ViewFilterMode = 'all' | 'video' | 'map'

export interface AudioInputDeviceInfo {
  deviceId: string
  label: string
}
