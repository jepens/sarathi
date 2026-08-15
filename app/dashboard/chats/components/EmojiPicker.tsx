'use client';

import { useEffect, useState } from 'react';
import {
    EmojiPicker as Frimousse,
    type EmojiPickerListEmojiProps,
    type EmojiPickerListCategoryHeaderProps,
} from 'frimousse';
import { cn } from '@/lib/utils';

// Themed wrapper around Frimousse (headless emoji picker) matching the WhatsApp
// composer look. Emoji metadata is fetched client-side on first open. onPick
// receives the native emoji character to splice into the message input; the
// panel intentionally stays open so the operator can add several in a row.
export function EmojiPickerPanel({ onPick }: { onPick: (emoji: string) => void }) {
    // The emoji dataset is fetched from a CDN on first open. If it stalls (offline
    // / blocked network), surface a hint instead of an infinite spinner — closing
    // and reopening the panel retries.
    const [slowLoad, setSlowLoad] = useState(false);
    useEffect(() => {
        const t = setTimeout(() => setSlowLoad(true), 7000);
        return () => clearTimeout(t);
    }, []);

    return (
        <Frimousse.Root
            onEmojiSelect={(e) => onPick(e.emoji)}
            columns={8}
            className="flex h-80 w-full flex-col bg-[var(--wa-panel)] text-[var(--wa-text)]"
        >
            <div className="p-2">
                <Frimousse.Search
                    autoFocus
                    placeholder="Cari emoji…"
                    className="w-full rounded-lg border-none bg-[var(--wa-search)] px-3 py-2 text-sm text-[var(--wa-text)] outline-none placeholder:text-[var(--wa-text-muted)]"
                />
            </div>
            <Frimousse.Viewport className="relative flex-1 overflow-y-auto">
                <Frimousse.Loading className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-[var(--wa-text-muted)]">
                    {slowLoad
                        ? 'Gagal memuat emoji — periksa koneksi, lalu tutup & buka lagi.'
                        : 'Memuat emoji…'}
                </Frimousse.Loading>
                <Frimousse.Empty className="absolute inset-0 flex items-center justify-center text-sm text-[var(--wa-text-muted)]">
                    Emoji tidak ditemukan
                </Frimousse.Empty>
                <Frimousse.List
                    className="select-none pb-1"
                    components={{
                        CategoryHeader: ({ category, ...props }: EmojiPickerListCategoryHeaderProps) => (
                            <div
                                {...props}
                                className="bg-[var(--wa-panel)] px-3 py-1 text-[11px] font-medium text-[var(--wa-text-muted)]"
                            >
                                {category.label}
                            </div>
                        ),
                        Emoji: ({ emoji, ...props }: EmojiPickerListEmojiProps) => (
                            <button
                                {...props}
                                className={cn(
                                    'flex h-full w-full items-center justify-center rounded-md text-2xl',
                                    emoji.isActive ? 'bg-[var(--wa-hover)]' : '',
                                )}
                            >
                                {emoji.emoji}
                            </button>
                        ),
                    }}
                />
            </Frimousse.Viewport>
        </Frimousse.Root>
    );
}
