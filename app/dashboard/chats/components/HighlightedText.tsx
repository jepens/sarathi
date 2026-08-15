'use client';

import { splitHighlight } from '@/lib/highlight';
import { cn } from '@/lib/utils';

// Renders `text` with every occurrence of `query` wrapped in <mark>. When
// `active` is set (this message is the current search hit) the marks use a
// stronger colour so the operator can see where they are.
export function HighlightedText({
    text,
    query,
    active,
}: {
    text: string;
    query: string;
    active?: boolean;
}) {
    const chunks = splitHighlight(text, query);
    return (
        <>
            {chunks.map((chunk, i) =>
                chunk.match ? (
                    <mark
                        key={i}
                        className={cn(
                            'rounded-sm',
                            active
                                ? 'bg-amber-400 text-black'
                                : 'bg-yellow-200 text-black dark:bg-yellow-300',
                        )}
                    >
                        {chunk.text}
                    </mark>
                ) : (
                    <span key={i}>{chunk.text}</span>
                ),
            )}
        </>
    );
}
