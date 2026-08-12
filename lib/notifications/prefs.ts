// A tiny external store for the notification preferences + current browser
// permission, read through useSyncExternalStore. This keeps browser-only state
// (localStorage, Notification.permission) out of useState/useEffect — so there's
// no set-state-in-effect churn and no SSR hydration skew (getServerSnapshot
// renders the defaults, the client swaps to the real values after hydration).

export type NotifPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export interface NotifPrefs {
    /** User opted in to desktop notifications. */
    enabled: boolean;
    /** In-app chime on. */
    soundOn: boolean;
    permission: NotifPermission;
}

const LS_ENABLED = 'sarathi:notif:enabled';
const LS_SOUND = 'sarathi:notif:sound';

// Stable reference for SSR + the first (pre-hydration) client render.
const SERVER_SNAPSHOT: NotifPrefs = { enabled: false, soundOn: true, permission: 'default' };

function readBool(key: string, fallback: boolean): boolean {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === '1';
}

function compute(): NotifPrefs {
    if (typeof window === 'undefined') return SERVER_SNAPSHOT;
    const permission: NotifPermission =
        'Notification' in window ? (Notification.permission as NotifPermission) : 'unsupported';
    return {
        enabled: readBool(LS_ENABLED, false),
        soundOn: readBool(LS_SOUND, true),
        permission,
    };
}

// useSyncExternalStore requires getSnapshot to return a STABLE reference until
// something actually changes — so we cache and only swap on a real diff.
let snapshot: NotifPrefs = typeof window === 'undefined' ? SERVER_SNAPSHOT : compute();
const listeners = new Set<() => void>();

function emit(): void {
    const next = compute();
    if (
        next.enabled !== snapshot.enabled ||
        next.soundOn !== snapshot.soundOn ||
        next.permission !== snapshot.permission
    ) {
        snapshot = next;
        for (const l of listeners) l();
    }
}

export function subscribeNotifPrefs(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function getNotifPrefs(): NotifPrefs {
    return snapshot;
}

export function getServerNotifPrefs(): NotifPrefs {
    return SERVER_SNAPSHOT;
}

export function setEnabledPref(value: boolean): void {
    window.localStorage.setItem(LS_ENABLED, value ? '1' : '0');
    emit();
}

export function setSoundPref(value: boolean): void {
    window.localStorage.setItem(LS_SOUND, value ? '1' : '0');
    emit();
}

/** Re-read the browser permission into the snapshot (after requestPermission). */
export function refreshNotifPrefs(): void {
    emit();
}
