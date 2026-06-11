'use client';

import { useEffect, useRef } from 'react';

// Cloudflare Turnstile (CAPTCHA) — anti-bot for the public signup form.
//
// Gated by NEXT_PUBLIC_TURNSTILE_SITE_KEY: with no key set this renders nothing
// and signup proceeds as before, so the form never breaks if CAPTCHA isn't
// configured. To turn it on:
//   1. Create a Turnstile widget at Cloudflare → copy the Site Key + Secret.
//   2. Set NEXT_PUBLIC_TURNSTILE_SITE_KEY on the app service.
//   3. Supabase → Auth → Bot & Abuse Protection → enable CAPTCHA, paste the
//      Secret. (Supabase then requires a captchaToken on signUp.)
//
// We use the vanilla Turnstile script (no npm dependency) so there's nothing
// extra to install or to break the build.

interface TurnstileGlobal {
    render: (el: HTMLElement, opts: Record<string, unknown>) => string;
    remove: (id: string) => void;
    reset: (id?: string) => void;
}
declare global {
    interface Window {
        turnstile?: TurnstileGlobal;
    }
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetId = useRef<string | null>(null);
    // Keep the latest callback in a ref so the render effect runs once (a fresh
    // inline onToken each render must not re-mount the widget).
    const onTokenRef = useRef(onToken);
    useEffect(() => {
        onTokenRef.current = onToken;
    }, [onToken]);

    useEffect(() => {
        if (!SITE_KEY) return;
        let cancelled = false;
        let poll: ReturnType<typeof setInterval> | undefined;

        const render = () => {
            if (cancelled || !containerRef.current || !window.turnstile || widgetId.current) return;
            widgetId.current = window.turnstile.render(containerRef.current, {
                sitekey: SITE_KEY,
                theme: 'auto',
                callback: (token: string) => onTokenRef.current(token),
                'expired-callback': () => onTokenRef.current(''),
                'error-callback': () => onTokenRef.current(''),
            });
        };

        if (window.turnstile) {
            render();
        } else if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
            const script = document.createElement('script');
            script.src = SCRIPT_SRC;
            script.async = true;
            script.defer = true;
            script.onload = render;
            document.head.appendChild(script);
        } else {
            poll = setInterval(() => {
                if (window.turnstile) {
                    if (poll) clearInterval(poll);
                    render();
                }
            }, 200);
        }

        return () => {
            cancelled = true;
            if (poll) clearInterval(poll);
            if (widgetId.current && window.turnstile) {
                try {
                    window.turnstile.remove(widgetId.current);
                } catch {
                    /* widget already gone */
                }
                widgetId.current = null;
            }
        };
    }, []);

    if (!SITE_KEY) return null;
    return <div ref={containerRef} className="min-h-[65px]" />;
}

// True when CAPTCHA is configured, so the form can require a token before submit.
export const TURNSTILE_ENABLED = Boolean(SITE_KEY);
