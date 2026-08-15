'use client';

import { cn } from '@/lib/utils';
import type { QuickReply } from '@/lib/quick-replies';

interface QuickReplyMenuProps {
    items: QuickReply[];
    highlight: number;
    onSelect: (qr: QuickReply) => void;
    onHover: (index: number) => void;
}

// Presentational list of quick replies, shared by the ⚡ picker and the "/"
// autocomplete. Keyboard nav (highlight) and filtering are owned by the composer.
export function QuickReplyMenu({ items, highlight, onSelect, onHover }: QuickReplyMenuProps) {
    if (items.length === 0) {
        return (
            <div className="px-3 py-3 text-sm text-[var(--wa-text-muted)]">
                Tidak ada balasan cepat yang cocok.
            </div>
        );
    }
    return (
        <ul className="max-h-64 overflow-y-auto py-1">
            {items.map((qr, i) => (
                <li key={qr.id}>
                    <button
                        type="button"
                        // Keep focus in the composer input: mousedown fires before the
                        // input's blur, so prevent it stealing focus.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onSelect(qr)}
                        onMouseEnter={() => onHover(i)}
                        className={cn(
                            'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left',
                            i === highlight ? 'bg-[var(--wa-hover)]' : 'hover:bg-[var(--wa-hover)]',
                        )}
                    >
                        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            /{qr.shortcut}
                        </span>
                        <span className="line-clamp-2 text-sm text-[var(--wa-text)]">{qr.content}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
}
