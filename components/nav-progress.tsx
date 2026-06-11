'use client';

import { usePathname } from 'next/navigation';

// Global navigation progress bar. Each route change remounts the inner bar via
// `key={pathname}`, restarting a one-shot CSS animation — no effects or state,
// so it's cheap and respects reduced motion (keyframes in globals.css). The
// per-page skeletons cover the client-side data fetch that follows the commit.
export function NavProgress() {
    const pathname = usePathname();
    return (
        <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5">
            <span key={pathname} className="nav-progress-bar block h-full bg-primary" />
        </div>
    );
}
