import type { MetadataRoute } from 'next'

// Web App Manifest — makes Helat installable to the home screen (Add to Home
// Screen on iOS, install prompt on Android/desktop) and launch standalone.
export default function manifest(): MetadataRoute.Manifest {
    return {
        name: 'Helat — Asisten Event Organizer',
        short_name: 'Helat',
        description:
            'Dari chat WhatsApp, jadi acara ter-booking. Asisten AI untuk Event Organizer.',
        start_url: '/dashboard',
        scope: '/',
        display: 'standalone',
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        icons: [
            { src: '/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
    }
}
