'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore,
} from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { unlockAudio, playDing } from '@/lib/notifications/sound';
import { setTitleBadge, setFaviconBadge, clearBadges } from '@/lib/notifications/badge';
import { isNewInbound, type ChatRealtimeRow } from '@/lib/notifications/inbound';
import {
    subscribeNotifPrefs,
    getNotifPrefs,
    getServerNotifPrefs,
    setEnabledPref,
    setSoundPref,
    refreshNotifPrefs,
    type NotifPermission,
} from '@/lib/notifications/prefs';

interface NotificationState {
    supported: boolean;
    permission: NotifPermission;
    /** User has opted in AND the browser granted permission. */
    active: boolean;
    soundOn: boolean;
    /** Ask for permission and turn desktop notifications on. */
    enable: () => Promise<void>;
    /** Turn desktop notifications off (keeps the permission grant). */
    disable: () => void;
    /** Toggle the in-app chime. */
    toggleSound: () => void;
}

const NotificationContext = createContext<NotificationState | null>(null);

export function useNotifications(): NotificationState {
    const ctx = useContext(NotificationContext);
    if (!ctx) throw new Error('useNotifications must be used within <NotificationProvider>');
    return ctx;
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();

    // Browser-derived prefs via an external store — no useState/useEffect, so no
    // set-state-in-effect and no hydration skew.
    const prefs = useSyncExternalStore(subscribeNotifPrefs, getNotifPrefs, getServerNotifPrefs);
    const { enabled, soundOn, permission } = prefs;

    // Unread-since-focus counter → tab title + favicon badge.
    const countRef = useRef(0);
    const bumpBadge = useCallback(() => {
        countRef.current += 1;
        setTitleBadge(countRef.current);
        setFaviconBadge(countRef.current);
    }, []);

    // Clear the badge the moment the operator looks back at the tab.
    useEffect(() => {
        const reset = () => {
            if (document.visibilityState === 'visible' && countRef.current !== 0) {
                countRef.current = 0;
                clearBadges();
            }
        };
        window.addEventListener('focus', reset);
        document.addEventListener('visibilitychange', reset);
        return () => {
            window.removeEventListener('focus', reset);
            document.removeEventListener('visibilitychange', reset);
        };
    }, []);

    // Web Audio needs a user gesture before it can make sound — unlock once.
    useEffect(() => {
        const unlock = () => unlockAudio();
        window.addEventListener('pointerdown', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
        return () => {
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
        };
    }, []);

    // The realtime notifier: one subscription for the whole dashboard session.
    // It reads the latest prefs from the store (getNotifPrefs) and the current
    // route from location at event time, so it never needs to re-subscribe.
    useEffect(() => {
        const supabase = createClient();
        const seen = new Map<string, number>();
        const mountFloor = Date.now();

        const openChat = (phone: string) =>
            router.push(`/dashboard/chats?phone=${encodeURIComponent(phone)}`);

        const showDesktopNotification = (name: string, body: string, phone: string) => {
            const url = `/dashboard/chats?phone=${encodeURIComponent(phone)}`;
            const options: NotificationOptions & { data?: { url: string } } = {
                body,
                tag: `wa:${phone}`,
                icon: '/icon-192x192.png',
                badge: '/icon-192x192.png',
                data: { url },
            };
            const fallback = () => {
                try {
                    const n = new Notification(name, options);
                    n.onclick = () => {
                        window.focus();
                        openChat(phone);
                        n.close();
                    };
                } catch {
                    /* no-op */
                }
            };
            // Prefer the service worker (works on desktop AND mobile; the click is
            // handled by the SW's notificationclick). Fall back to a plain
            // Notification with an inline handler where no SW is available.
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.ready
                    .then((reg) => reg.showNotification(name, options))
                    .catch(fallback);
            } else {
                fallback();
            }
        };

        const handle = (row: ChatRealtimeRow) => {
            const prev = seen.get(row.phone_number);
            const fresh = isNewInbound(row, prev, mountFloor);
            const inboundMs = row.last_inbound_at ? Date.parse(row.last_inbound_at) : NaN;
            if (Number.isFinite(inboundMs)) seen.set(row.phone_number, inboundMs);
            if (!fresh) return;

            const { soundOn: soundNow, enabled: enabledNow, permission: permNow } = getNotifPrefs();
            const active = enabledNow && permNow === 'granted';
            const name = row.contact_name || row.phone_number;
            const preview = row.last_message || 'Pesan baru';
            const hidden = document.visibilityState === 'hidden';
            const onInbox =
                typeof window !== 'undefined' &&
                window.location.pathname.startsWith('/dashboard/chats');

            if (soundNow) playDing();
            bumpBadge();

            if (active && hidden) {
                // Tab not focused → OS/desktop notification (like WhatsApp Web).
                showDesktopNotification(name, preview, row.phone_number);
            } else if (!hidden && !onInbox) {
                // Looking at another part of the app → a gentle in-app toast with a
                // jump link (the inbox list updates itself, so skip it there).
                toast(`💬 ${name}`, {
                    description: preview,
                    action: { label: 'Buka', onClick: () => openChat(row.phone_number) },
                });
            }
        };

        const channel = supabase
            .channel('notif_inbound')
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'whatsapp_chats' },
                (payload) => handle(payload.new as ChatRealtimeRow),
            )
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'whatsapp_chats' },
                (payload) => handle(payload.new as ChatRealtimeRow),
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [router, bumpBadge]);

    const enable = useCallback(async () => {
        if (typeof window === 'undefined' || !('Notification' in window)) return;
        let perm = Notification.permission as NotifPermission;
        if (perm === 'default') perm = (await Notification.requestPermission()) as NotifPermission;
        if (perm === 'granted') {
            setEnabledPref(true);
            unlockAudio();
        }
        refreshNotifPrefs();
    }, []);

    const disable = useCallback(() => setEnabledPref(false), []);
    const toggleSound = useCallback(() => setSoundPref(!getNotifPrefs().soundOn), []);

    const value = useMemo<NotificationState>(
        () => ({
            supported: permission !== 'unsupported',
            permission,
            active: enabled && permission === 'granted',
            soundOn,
            enable,
            disable,
            toggleSound,
        }),
        [permission, enabled, soundOn, enable, disable, toggleSound],
    );

    return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}
