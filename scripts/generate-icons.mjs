// One-off PWA icon generator. Draws the Sarathi "Chakra-dial" mark geometrically
// (no font dependency, crisp at any size): a nila (indigo) spoked chariot wheel
// with a heritage-gold hub and one gold "lit" spoke — the active stage on the
// dial. Mirrors components/sarathi-mark.tsx exactly (48-unit viewBox geometry).
// Run: `node scripts/generate-icons.mjs`
import { createCanvas } from 'canvas';
import { mkdirSync, writeFileSync } from 'fs';

mkdirSync('public', { recursive: true });

const INK = '#0b0b0e'; // base malam
const NILA = '#818cf8'; // wheel (brand-indigo-lit)
const GOLD = '#e6b450'; // hub + lit spoke (Kanaka)
const SPOKES = 8;
const LIT = 1; // gold "active" spoke, clockwise from top

function icon(size, { scale = 1 } = {}) {
    const c = createCanvas(size, size);
    const ctx = c.getContext('2d');

    // Background — brand ink, full-bleed (also fills the maskable safe zone).
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    // viewBox(48) → px, carrying the maskable `scale` so the mark pulls into
    // the safe zone without distorting its proportions.
    const u = (n) => ((size * n) / 48) * scale;

    // rim
    ctx.strokeStyle = NILA;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = u(2);
    ctx.beginPath();
    ctx.arc(cx, cy, u(19), 0, Math.PI * 2);
    ctx.stroke();

    // spokes — one gold-lit
    ctx.lineCap = 'round';
    for (let i = 0; i < SPOKES; i++) {
        const a = ((-90 + (360 / SPOKES) * i) * Math.PI) / 180;
        const isLit = i === LIT;
        ctx.strokeStyle = isLit ? GOLD : NILA;
        ctx.globalAlpha = isLit ? 1 : 0.5;
        ctx.lineWidth = isLit ? u(2.75) : u(1.5);
        ctx.beginPath();
        ctx.moveTo(cx + u(7) * Math.cos(a), cy + u(7) * Math.sin(a));
        ctx.lineTo(cx + u(17) * Math.cos(a), cy + u(17) * Math.sin(a));
        ctx.stroke();
    }

    // hub
    ctx.globalAlpha = 1;
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.arc(cx, cy, u(3.4), 0, Math.PI * 2);
    ctx.fill();

    return c.toBuffer('image/png');
}

writeFileSync('public/icon-192x192.png', icon(192));
writeFileSync('public/icon-512x512.png', icon(512));
writeFileSync('public/icon-512-maskable.png', icon(512, { scale: 0.66 }));
writeFileSync('public/apple-icon.png', icon(180));
// Browser-tab favicon — Next's app router auto-wires app/icon.png.
writeFileSync('app/icon.png', icon(512));

console.log('Generated Sarathi PWA icons in public/ and app/icon.png');
