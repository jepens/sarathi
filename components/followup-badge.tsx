'use client';

import { useEffect, useState } from 'react';

// Small count badge for the "Follow-up" sidebar item. Fetches the live count and
// refreshes every few minutes. Renders nothing when there's nothing to do.
export function FollowupBadge() {
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
        <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground">
            {count > 99 ? '99+' : count}
        </span>
    );
}
