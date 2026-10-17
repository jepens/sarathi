// Keeps a chat voice note or video playable after the signed URL behind it
// expires (tracker 1.11, review of PR #47).
//
// ChatWindow's <audio> / <video> load /api/chat-media/<id>, which answers with
// a 302 to a signed URL. The media element follows that redirect once and then
// sends every later range request (play, seek, buffering) straight to the
// signed URL, never to the route again (seen in Chrome). Once the token
// expires, playback stops at the end of what is buffered: Storage answers each
// retry with 400 and no error event fires. keepStreamFresh notes when the
// current source's metadata arrived; a play, seek or stall after
// CHAT_MEDIA_STREAM_FRESH_MS reloads the source through a new redirect (a
// query no cache holds) and then restores the position and the play state.

import { CHAT_MEDIA_STREAM_FRESH_MS } from '@/lib/storage/chat-media';

/** The part of HTMLMediaElement keepStreamFresh uses. */
export interface StreamElement extends EventTarget {
    src: string;
    preload: string;
    currentTime: number;
    readonly paused: boolean;
    readonly ended: boolean;
    play(): Promise<void>;
}

interface KeepStreamFreshOptions {
    /** How long after its metadata arrived a source is played or seeked as is. */
    freshMs?: number;
    now?: () => number;
}

/**
 * Watches `el`, whose source is `href` (chatMediaHref), and renews the source
 * once it may be about to expire. Returns the function that stops watching.
 */
export function keepStreamFresh(
    el: StreamElement,
    href: string,
    { freshMs = CHAT_MEDIA_STREAM_FRESH_MS, now = Date.now }: KeepStreamFreshOptions = {}
): () => void {
    // When the current source's metadata arrived: null before the first load
    // (preload="none" fetches nothing until play) and while a renewal loads.
    let loadedAt: number | null = null;
    // A renewal in flight: where to continue, and whether to play.
    let resume: { time: number; play: boolean } | null = null;

    const renewIfStale = (play: boolean) => {
        if (resume || loadedAt === null || now() - loadedAt <= freshMs) return;
        // A play on an ended element starts again from the beginning.
        resume = { time: el.ended ? 0 : el.currentTime, play };
        loadedAt = null;
        // With preload="none" the new source would wait for another play, and
        // the position could not be restored: load its metadata right away.
        if (el.preload === 'none') el.preload = 'metadata';
        el.src = `${href}?r=${now()}`;
    };

    const onLoadedMetadata = () => {
        loadedAt = now();
        const target = resume;
        resume = null;
        if (!target) return;
        if (target.time > 0) el.currentTime = target.time;
        if (target.play) el.play().catch(() => {}); // e.g. refused by an autoplay policy
    };
    // While a renewal loads, the user's latest play or pause wins.
    const onPlay = () => {
        if (resume) resume.play = true;
        else renewIfStale(true);
    };
    const onPause = () => {
        if (resume) resume.play = false;
    };
    const onSeekingOrStalled = () => renewIfStale(!el.paused);

    const listeners: Array<[string, () => void]> = [
        ['loadedmetadata', onLoadedMetadata],
        ['play', onPlay],
        ['pause', onPause],
        ['seeking', onSeekingOrStalled],
        ['stalled', onSeekingOrStalled],
        ['waiting', onSeekingOrStalled],
    ];
    for (const [type, listener] of listeners) el.addEventListener(type, listener);
    return () => {
        for (const [type, listener] of listeners) el.removeEventListener(type, listener);
    };
}
