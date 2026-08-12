// Client-only. WhatsApp-Web-style unread badge: a "(N)" prefix on the tab title
// plus a red count drawn onto the favicon. Both are best-effort and fully
// guarded — a failure never throws into the caller.

const TITLE_PREFIX_RE = /^\(\d+\)\s*/;

function baseTitle(): string {
    return document.title.replace(TITLE_PREFIX_RE, '');
}

/** Prefix the tab title with "(N) " when count > 0, restore it at 0. */
export function setTitleBadge(count: number): void {
    if (typeof document === 'undefined') return;
    const base = baseTitle();
    document.title = count > 0 ? `(${count > 9 ? '9+' : count}) ${base}` : base;
}

let baseIcon: HTMLImageElement | null = null;
function ensureBaseIcon(): HTMLImageElement {
    if (!baseIcon) {
        baseIcon = new Image();
        baseIcon.src = '/icon-192x192.png';
    }
    return baseIcon;
}

function applyFavicon(href: string): void {
    let link = document.querySelector<HTMLLinkElement>('link#notif-favicon');
    if (!link) {
        link = document.createElement('link');
        link.id = 'notif-favicon';
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    link.href = href;
}

/** Draw the app icon with a red unread-count bubble (or plain icon at 0). */
export function setFaviconBadge(count: number): void {
    if (typeof document === 'undefined') return;
    try {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const cx = canvas.getContext('2d');
        if (!cx) return;

        const render = () => {
            cx.clearRect(0, 0, size, size);
            const img = ensureBaseIcon();
            if (img.complete && img.naturalWidth > 0) {
                cx.drawImage(img, 0, 0, size, size);
            }
            if (count > 0) {
                const r = 22;
                const cxp = size - r;
                const cyp = r;
                cx.beginPath();
                cx.arc(cxp, cyp, r, 0, Math.PI * 2);
                cx.fillStyle = '#ef4444';
                cx.fill();
                cx.fillStyle = '#ffffff';
                cx.font = 'bold 34px system-ui, sans-serif';
                cx.textAlign = 'center';
                cx.textBaseline = 'middle';
                cx.fillText(count > 9 ? '9+' : String(count), cxp, cyp + 1);
            }
            applyFavicon(canvas.toDataURL('image/png'));
        };

        const img = ensureBaseIcon();
        if (img.complete) render();
        else img.onload = render;
    } catch {
        /* favicon badge is cosmetic — never let it break notifications */
    }
}

/** Reset both badges to the unread-free state. */
export function clearBadges(): void {
    setTitleBadge(0);
    setFaviconBadge(0);
}
