'use client'

import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import type { Room } from 'livekit-client'
import { AudioControls } from './AudioControls'

interface RoomHeaderProps {
  roomName?: string
  room?: Room | null
  isConnected: boolean
  isConnecting: boolean
  participantsCount: number
  isAudioUnlocked: boolean
  isAutoArrange?: boolean
  filterMode?: any
  onToggleAutoArrange?: () => void
  onChangeFilter?: any
  onDisconnect?: () => void
  onUnlockAudio: () => void
}

export function RoomHeader({
  room,
  isConnected,
  isConnecting,
  participantsCount,
  isAudioUnlocked,
  onUnlockAudio,
}: RoomHeaderProps) {
  return (
    <header className="h-14 px-5 bg-white border-b border-slate-200 flex items-center justify-between gap-4 z-20 shrink-0 shadow-sm">
      {/* Título + estado */}
      <div className="flex items-center gap-3">
        <div className="size-8 rounded-lg bg-blue-600/15 border border-blue-500/25 flex items-center justify-center text-blue-500 shrink-0">
          {isConnecting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : isConnected ? (
            <Wifi className="size-4" />
          ) : (
            <WifiOff className="size-4 text-slate-400" />
          )}
        </div>
        <span className="text-sm font-bold text-slate-800">Centro de Monitoreo</span>
        <div className="flex items-center gap-1.5">
          <span
            className={`size-2 rounded-full shrink-0 ${
              isConnected
                ? 'bg-emerald-400 shadow-[0_0_8px_#10b981]'
                : isConnecting
                ? 'bg-amber-400 animate-pulse'
                : 'bg-slate-300'
            }`}
          />
          <span className="text-xs text-slate-500">
            {isConnected
              ? participantsCount > 0
                ? `${participantsCount} casco(s) en vivo`
                : 'En línea'
              : isConnecting
              ? 'Conectando...'
              : 'Sin conexión'}
          </span>
        </div>
      </div>

      {/* Controles de audio */}
      <AudioControls
        room={room ?? null}
        isAudioUnlocked={isAudioUnlocked}
        onUnlockAudio={onUnlockAudio}
      />
    </header>
  )
}
