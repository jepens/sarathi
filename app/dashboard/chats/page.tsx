'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChatList } from './components/ChatList';
import { ChatWindow } from './components/ChatWindow';

function ChatsInbox() {
    const searchParams = useSearchParams();
    // Deep link from other pages (e.g. Vendors "Buka chat"): /dashboard/chats?phone=...
    // Derived once during render (lazy init) so we never setState in an effect.
    const [selectedPhone, setSelectedPhone] = useState<string | null>(
        () => searchParams.get('phone')
    );

    return (
        <div className="flex h-[calc(100vh-8rem)] border rounded-lg overflow-hidden bg-background shadow-sm">
            <div className="w-1/3 border-r bg-muted/10 flex-shrink-0">
                <ChatList
                    selectedPhone={selectedPhone}
                    onSelect={setSelectedPhone}
                />
            </div>
            <div className="flex-1 bg-background overflow-hidden">
                {selectedPhone ? (
                    <ChatWindow phoneNumber={selectedPhone} />
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8 text-center">
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
