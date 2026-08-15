'use client';

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { labelColor, type Label } from '@/lib/labels';

// A single colored label chip (dot + name). Shared by the chat list, the chat
// header picker, and the settings editor. When onRemove is set it grows a small
// "×" — never render that variant inside another <button> (nested buttons are
// invalid HTML).
export function LabelBadge({
    label,
    size = 'sm',
    onRemove,
    className,
}: {
    label: Pick<Label, 'name' | 'color'>;
    size?: 'xs' | 'sm';
    onRemove?: () => void;
    className?: string;
}) {
    const c = labelColor(label.color);
    return (
        <span
            className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-full border font-medium leading-none',
                size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]',
                c.chip,
                className,
            )}
        >
            <span className={cn('shrink-0 rounded-full', size === 'xs' ? 'h-1.5 w-1.5' : 'h-2 w-2', c.dot)} />
            <span className="truncate">{label.name}</span>
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={`Lepas label ${label.name}`}
                    className="-mr-0.5 ml-0.5 shrink-0 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/15"
                >
                    <X className={size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                </button>
            )}
        </span>
    );
}
