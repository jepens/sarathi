'use client';

import { cn } from '@/lib/utils';

// The little quoted block shown above a reply (both in a message bubble and in
// the composer preview). sender + snippet are pre-resolved by the caller so this
// stays decoupled from the Message type. When onClick is set it renders as a
// button (used to jump to the original message).
export function QuotedMessage({
    sender,
    snippet,
    onClick,
    className,
}: {
    sender: string;
    snippet: string;
    onClick?: () => void;
    className?: string;
}) {
    const base = cn(
        'flex w-full flex-col items-start gap-0.5 overflow-hidden rounded-md border-l-4 border-emerald-500 bg-black/5 px-2 py-1 text-left dark:bg-white/10',
        className,
    );
    const inner = (
        <>
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{sender}</span>
            <span className="line-clamp-2 w-full truncate text-xs text-[var(--wa-text-muted)]">{snippet}</span>
        </>
    );
    if (onClick) {
        return (
            <button
                type="button"
                onClick={onClick}
                className={cn(base, 'cursor-pointer hover:bg-black/10 dark:hover:bg-white/15')}
            >
                {inner}
            </button>
        );
    }
    return <div className={base}>{inner}</div>;
}
