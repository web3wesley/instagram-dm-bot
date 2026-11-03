// Generates assets/app-icon-1024.png (the Meta app icon) with no dependencies:
// a dark tile with a white speech bubble and three accent dots. Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const SIZE = 1024;
const SS = 3; // supersampling per axis for smooth edges
const BG_TOP = [17, 24, 39];
const BG_BOTTOM = [31, 41, 55];
const WHITE = [255, 255, 255];
const ACCENT = [249, 115, 22];

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const sign = (px, py, ax, ay, bx, by) => (px - bx) * (ay - by) - (ax - bx) * (py - by);
const inTriangle = (x, y, a, b, c) => {
  const d1 = sign(x, y, ...a, ...b);
  const d2 = sign(x, y, ...b, ...c);
  const d3 = sign(x, y, ...c, ...a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function colorAt(x, y) {
  for (const cx of [372, 512, 652]) if (inCircle(x, y, cx, 452, 44)) return ACCENT;
  if (inRoundRect(x, y, 202, 252, 822, 652, 120)) return WHITE;
  if (inTriangle(x, y, [330, 600], [290, 800], [500, 640])) return WHITE;
  const t = y / SIZE;
  return BG_TOP.map((c, i) => c + (BG_BOTTOM[i] - c) * t);
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let py = 0; py < SIZE; py++) {
  const row = py * (1 + SIZE * 4);
  raw[row] = 0; // filter: none
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = colorAt(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
        r += c[0];
        g += c[1];
        b += c[2];
      }
    }
    const n = SS * SS;
    const o = row + 1 + px * 4;
    raw[o] = Math.round(r / n);
    raw[o + 1] = Math.round(g / n);
    raw[o + 2] = Math.round(b / n);
    raw[o + 3] = 255;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = new URL('../assets/app-icon-1024.png', import.meta.url);
mkdirSync(new URL('../assets/', import.meta.url), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out.pathname} (${png.length} bytes)`);
