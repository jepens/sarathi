'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

// Small count badge for the "Follow-up" sidebar item. Fetches the live count and
// refreshes every few minutes. Renders nothing when there's nothing to do.
// `collapsed` pins it as a small corner dot over the icon in the icon-only rail.
export function FollowupBadge({ collapsed = false }: { collapsed?: boolean }) {
    const [count, setCount] = useState(0);

    useEffect(() => {
        let active = true;
        const load = async () => {
            try {
                const res = await fetch('/api/followup', { cache: 'no-store' });
                if (!res.ok) return;
                const data = await res.json();
                if (active) setCount(data?.counts?.total ?? 0);
            } catch {
                /* non-fatal — badge just won't show */
            }
        };
        load();
        const id = setInterval(load, 5 * 60 * 1000);
        return () => {
            active = false;
            clearInterval(id);
        };
    }, []);

    if (count <= 0) return null;
    return (
        <span
            className={cn(
                'inline-flex items-center justify-center rounded-full bg-primary font-medium text-primary-foreground',
                collapsed
                    ? 'absolute right-1 top-1 h-4 min-w-4 px-1 text-[10px] leading-none'
                    : 'ml-auto h-5 min-w-5 px-1.5 text-[11px]',
            )}
        >
            {count > 99 ? '99+' : count}
        </span>
    );
}
