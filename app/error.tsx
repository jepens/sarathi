'use client' // Error boundaries must be Client Components

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

// Root-segment error boundary. It also catches errors thrown by
// app/dashboard/layout.tsx — e.g. when the session could not be verified right
// now (Auth unreachable). That case must NOT redirect to /login (the proxy may
// still see a session and bounce back → redirect loop), so the layout throws
// and the user lands here with a retry.
export default function ErrorPage({
    error,
    retry,
}: {
    error: Error & { digest?: string }
    retry: () => void
}) {
    useEffect(() => {
        console.error(error)
    }, [error])

    return (
        <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-center">
            <h1 className="text-xl font-semibold">Terjadi gangguan sementara</h1>
            <p className="max-w-md text-sm text-muted-foreground">
                Kami tidak dapat memuat halaman ini sekarang. Silakan coba lagi sebentar lagi.
            </p>
            <Button onClick={() => retry()}>Coba lagi</Button>
            {error.digest ? (
                <p className="text-xs text-muted-foreground">Kode: {error.digest}</p>
            ) : null}
        </main>
    )
}
