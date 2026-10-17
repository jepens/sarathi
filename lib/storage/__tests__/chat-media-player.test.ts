import { describe, it, expect, beforeEach } from 'vitest';
import { keepStreamFresh, type StreamElement } from '@/lib/storage/chat-media-player';

// keepStreamFresh (tracker 1.11, review of PR #47): a voice note or video
// follows the /api/chat-media 302 once and then talks to the signed URL
// directly, so a play, seek or stall after the fresh window reloads the source
// through a new redirect and continues where the user was. The fake element
// behaves like the media element load algorithm: assigning src goes back to
// the start, paused, without a 'pause' event.

const HREF = '/api/chat-media/5e1f0000-0000-4000-8000-0000000000c1';
const FRESH_MS = 1000;

class FakeMedia extends EventTarget implements StreamElement {
    private source = HREF;
    /** Every src assigned after mount. */
    sources: string[] = [];
    preload = 'metadata';
    currentTime = 0;
    paused = true;
    ended = false;
    /** play() calls made by code (not by the user). */
    plays = 0;
    refusePlay = false;

    get src() {
        return this.source;
    }
    set src(value: string) {
        this.source = value;
        this.sources.push(value);
        this.currentTime = 0;
        this.paused = true;
        this.ended = false;
    }
    play() {
        this.plays++;
        if (this.refusePlay) return Promise.reject(new DOMException('autoplay', 'NotAllowedError'));
        this.paused = false;
        this.fire('play');
        return Promise.resolve();
    }
    fire(type: string) {
        this.dispatchEvent(new Event(type));
    }
    // What the native controls do.
    userPlay() {
        this.paused = false;
        this.fire('play');
    }
    userPause() {
        this.paused = true;
        this.fire('pause');
    }
    userSeek(time: number) {
        this.currentTime = time;
        this.fire('seeking');
    }
}

let t = 0;
let el: FakeMedia;
let stop: () => void;

beforeEach(() => {
    t = 0;
    el = new FakeMedia();
    stop = keepStreamFresh(el, HREF, { freshMs: FRESH_MS, now: () => t });
});

describe('keepStreamFresh', () => {
    it('plays a fresh source as is', () => {
        el.fire('loadedmetadata');
        t = FRESH_MS;
        el.userPlay();
        el.userSeek(30);
        el.fire('waiting');
        expect(el.sources).toEqual([]);
        expect(el.paused).toBe(false);
    });

    it('a play after the window reloads through a new redirect and resumes at the same position', () => {
        el.fire('loadedmetadata');
        el.userPlay();
        el.currentTime = 12;
        el.userPause();
        t = 5000;
        el.userPlay();
        expect(el.sources).toEqual([`${HREF}?r=5000`]);

        t = 5300;
        el.fire('loadedmetadata');
        expect(el.currentTime).toBe(12);
        expect(el.plays).toBe(1);
        expect(el.paused).toBe(false);
    });

    it('a seek after the window reloads, keeping the target and the paused state', () => {
        el.fire('loadedmetadata');
        t = 5000;
        el.userSeek(90);
        expect(el.sources).toEqual([`${HREF}?r=5000`]);

        el.fire('loadedmetadata');
        expect(el.currentTime).toBe(90);
        expect(el.plays).toBe(0);
        expect(el.paused).toBe(true);
    });

    it.each(['stalled', 'waiting'])("a '%s' during playback after the window reloads and keeps playing", (type) => {
        el.fire('loadedmetadata');
        el.userPlay();
        el.currentTime = 30;
        t = 5000;
        el.fire(type);
        expect(el.sources).toHaveLength(1);

        el.fire('loadedmetadata');
        expect(el.currentTime).toBe(30);
        expect(el.plays).toBe(1);
    });

    it('does nothing before the first load (preload="none": the first play fetches a fresh redirect anyway)', () => {
        el.preload = 'none';
        t = 10 * FRESH_MS;
        el.userPlay();
        el.userSeek(5);
        expect(el.sources).toEqual([]);
        expect(el.preload).toBe('none');
    });

    it('a renewed preload="none" voice note loads its metadata right away, so a paused seek is restored', () => {
        el.preload = 'none';
        el.userPlay();
        el.fire('loadedmetadata');
        el.userPause();
        t = 5000;
        el.userSeek(300);
        expect(el.preload).toBe('metadata');
        expect(el.sources).toHaveLength(1);
        el.fire('loadedmetadata');
        expect(el.currentTime).toBe(300);
        expect(el.plays).toBe(0);
    });

    it('renews once; during the reload the last play or pause of the user wins', () => {
        el.fire('loadedmetadata');
        t = 5000;
        el.userSeek(40); // paused: renews with play = false
        el.fire('waiting');
        el.userPlay();
        el.fire('stalled');
        expect(el.sources).toHaveLength(1);
        el.fire('loadedmetadata');
        expect(el.plays).toBe(1);
        expect(el.currentTime).toBe(40);

        t = 10_000;
        el.userPlay(); // renews with play = true...
        el.userPause(); // ...then the user pauses while it loads
        el.fire('loadedmetadata');
        expect(el.sources).toHaveLength(2);
        expect(el.plays).toBe(1);
    });

    it('a play on an ended element starts again from the beginning', () => {
        el.fire('loadedmetadata');
        el.currentTime = 40;
        el.ended = true;
        t = 5000;
        el.userPlay();
        el.fire('loadedmetadata');
        expect(el.currentTime).toBe(0);
        expect(el.plays).toBe(1);
    });

    it('the renewed source gets a fresh window of its own, and each renewal a new URL', () => {
        el.fire('loadedmetadata');
        t = 5000;
        el.userPlay();
        t = 5100;
        el.fire('loadedmetadata');
        t = 5100 + FRESH_MS;
        el.userSeek(3);
        expect(el.sources).toHaveLength(1);
        t = 5101 + FRESH_MS;
        el.userSeek(4);
        expect(el.sources).toEqual([`${HREF}?r=5000`, `${HREF}?r=${5101 + FRESH_MS}`]);
    });

    it('a play refused by the browser after the reload is swallowed', async () => {
        el.fire('loadedmetadata');
        t = 5000;
        el.userPlay();
        el.refusePlay = true;
        el.fire('loadedmetadata');
        await Promise.resolve();
        expect(el.plays).toBe(1);
    });

    it('stops listening', () => {
        el.fire('loadedmetadata');
        stop();
        t = 5000;
        el.userPlay();
        expect(el.sources).toEqual([]);
    });
});
