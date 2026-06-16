// Optimizes the raw Sailendra logos in docs/ into small, tightly-cropped web
// assets in public/. Both source PNGs are content-on-transparent, so we trim by
// alpha and resize to a small height (the logo is only ever shown as a tiny
// "by" credit). Run: `node scripts/optimize-logo.mjs`
import { createCanvas, loadImage } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('public', { recursive: true });

async function optimize(src, out, targetH = 64) {
    const img = await loadImage(src);
    const w = img.width;
    const h = img.height;
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);

    // Tight bounding box of non-transparent pixels.
    let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 16) {
                found = true;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (!found) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1; }
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    const outH = targetH;
    const outW = Math.round((cw / ch) * targetH);

    const o = createCanvas(outW, outH);
    const octx = o.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(img, minX, minY, cw, ch, 0, 0, outW, outH);
    writeFileSync(out, o.toBuffer('image/png'));
    console.log(`${out} -> ${outW}x${outH} (trimmed ${cw}x${ch} from ${w}x${h})`);
}

await optimize('docs/Logo Sailendra White.png', 'public/sailendra-white.png');
await optimize('docs/Sailendra black Logo.png', 'public/sailendra-black.png');
