'use client'

import { useEffect } from 'react'

// Registers the service worker once, after load, so it never competes with
// hydration. Failures are non-fatal (the app works fine without it). No state is
// set here, so it stays clear of the repo's no-setState-in-effect rule.
export function SwRegister() {
    useEffect(() => {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

        const register = () => {
            navigator.serviceWorker
                .register('/sw.js', { scope: '/', updateViaCache: 'none' })
                .catch((err) => console.error('Service worker registration failed', err))
        }

        if (document.readyState === 'complete') {
            register()
            return
        }
        window.addEventListener('load', register, { once: true })
        return () => window.removeEventListener('load', register)
    }, [])

    return null
}
