// Client-only. A short two-tone "ding" synthesized with the Web Audio API — no
// audio asset to ship or cache. Browsers block audio until a user gesture, so
// call unlockAudio() from a one-time pointer/key listener before playDing().

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
        try {
            ctx = new AC();
        } catch {
            return null;
        }
    }
    return ctx;
}

/** Resume the AudioContext inside a user gesture so later playDing() calls sound. */
export function unlockAudio(): void {
    const c = getCtx();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
}

/** Play a brief pleasant two-note chime. No-op if audio isn't available/unlocked. */
export function playDing(): void {
    const c = getCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    const now = c.currentTime;
    // Two ascending notes (A5 → E6) with a quick pluck envelope.
    const notes = [
        { freq: 880, at: 0 },
        { freq: 1320, at: 0.12 },
    ];
    for (const n of notes) {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = n.freq;
        const t0 = now + n.at;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        osc.connect(gain).connect(c.destination);
        osc.start(t0);
        osc.stop(t0 + 0.2);
    }
}
