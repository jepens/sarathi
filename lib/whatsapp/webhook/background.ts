import { whatsappLogger } from '@/lib/utils/logger';

// Work a delivery starts but does not wait for (pushes, notes, the rate-limit
// warning, queue drains, media downloads): Meta gets its answer first, and a
// failure here never changes it. The promises are kept until they settle, so
// tests can wait for them instead of polling.

const pending = new Set<Promise<void>>();

/** Starts fn without waiting for it. Never throws; a failure is logged with its label. */
export function runInBackground(label: string, fn: () => unknown): void {
    const task: Promise<void> = (async () => {
        await fn();
    })()
        .catch((error) => {
            whatsappLogger.error(`Background task failed: ${label}`, error);
        })
        .finally(() => {
            pending.delete(task);
        });
    pending.add(task);
}

/** Tests: resolves once every background task, including any they started, has settled. */
export async function settleBackground(): Promise<void> {
    while (pending.size > 0) {
        await Promise.allSettled([...pending]);
    }
}
