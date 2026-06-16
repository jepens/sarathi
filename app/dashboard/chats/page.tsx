'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChatList } from './components/ChatList';
import { ChatWindow } from './components/ChatWindow';
import { cn } from '@/lib/utils';

function ChatsInbox() {
    const searchParams = useSearchParams();
    // Deep link from other pages (e.g. Vendors "Buka chat"): /dashboard/chats?phone=...
    // Derived once during render (lazy init) so we never setState in an effect.
    const [selectedPhone, setSelectedPhone] = useState<string | null>(
        () => searchParams.get('phone')
    );

    return (
        // Master-detail: ONE pane on mobile — the list, then it swaps to the
        // conversation (with a back button in the header) once a chat is picked.
        // Two panes side-by-side from md up. Height uses dvh and subtracts the
        // mobile top bar (3.5rem) + main padding so the composer never sits under
        // the browser chrome / keyboard; on md+ only the desktop p-8 (4rem).
        <div className="wa-inbox flex h-[calc(100dvh-5.5rem)] overflow-hidden rounded-lg border bg-background shadow-sm md:h-[calc(100dvh-4rem)]">
            <div
                className={cn(
                    'w-full flex-shrink-0 border-r bg-muted/10 md:w-1/3',
                    selectedPhone ? 'hidden md:block' : 'block'
                )}
            >
                <ChatList selectedPhone={selectedPhone} onSelect={setSelectedPhone} />
            </div>
            <div
                className={cn(
                    'flex-1 overflow-hidden bg-background',
                    selectedPhone ? 'block' : 'hidden md:block'
                )}
            >
                {selectedPhone ? (
                    <ChatWindow
                        phoneNumber={selectedPhone}
                        onBack={() => setSelectedPhone(null)}
                    />
                ) : (
                    <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
                        <h3 className="text-lg font-medium mb-2">WhatsApp Inbox</h3>
                        <p className="text-sm">Pilih percakapan dari daftar untuk melihat riwayat & membalas.</p>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function ChatsPage() {
    return (
        <Suspense fallback={null}>
            <ChatsInbox />
        </Suspense>
    );
}
