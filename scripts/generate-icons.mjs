// One-off PWA icon generator. Draws Helat's "H" monogram geometrically (no font
// dependency, crisp at any size) in white on a charcoal background, matching the
// app's dark, monochrome identity. Run: `node scripts/generate-icons.mjs`
import { createCanvas } from 'canvas';
import { mkdirSync, writeFileSync } from 'fs';

mkdirSync('public', { recursive: true });

function icon(size, { scale = 1 } = {}) {
    const c = createCanvas(size, size);
    const ctx = c.getContext('2d');

    // Background — charcoal (on-brand dark, visible on most home screens).
    ctx.fillStyle = '#111113';
    ctx.fillRect(0, 0, size, size);

    // White "H", centered. `scale` < 1 pulls it into the maskable safe zone.
    ctx.fillStyle = '#ffffff';
    const cx = size / 2;
    const cy = size / 2;
    const hW = size * 0.4 * scale; // total width
    const hH = size * 0.4 * scale; // total height
    const bar = size * 0.12 * scale; // stroke thickness
    const left = cx - hW / 2;
    const right = cx + hW / 2 - bar;
    const top = cy - hH / 2;

    ctx.fillRect(left, top, bar, hH); // left vertical
    ctx.fillRect(right, top, bar, hH); // right vertical
    ctx.fillRect(left, cy - bar / 2, hW, bar); // crossbar

    return c.toBuffer('image/png');
}

writeFileSync('public/icon-192x192.png', icon(192));
writeFileSync('public/icon-512x512.png', icon(512));
writeFileSync('public/icon-512-maskable.png', icon(512, { scale: 0.66 }));
writeFileSync('public/apple-icon.png', icon(180));

console.log('Generated PWA icons in public/');
