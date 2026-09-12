import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Centro de Monitoreo — Cascos Inteligentes LiveKit',
  description: 'Sala de operaciones y monitoreo en tiempo real para cascos inteligentes con WebRTC, telemetría y geolocalización GPS.',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0b0f17',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="es" className="dark">
      <head>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
          crossOrigin=""
        />
      </head>
      <body className="bg-background text-foreground antialiased selection:bg-primary selection:text-white">
        {children}
      </body>
    </html>
  )
}
