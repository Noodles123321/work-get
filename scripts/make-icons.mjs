// 生成扩展图标（无第三方依赖）。运行：node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUT_DIR = resolve(process.cwd(), 'public/icon');
const SIZES = [16, 32, 48, 128];

const BG = [15, 118, 110]; // #0f766e
const FG = [255, 255, 255];

/** W 字形折线（单位坐标，按画布缩放） */
const STROKES = [
  [[0.24, 0.2], [0.4, 0.8]],
  [[0.4, 0.8], [0.5, 0.45]],
  [[0.5, 0.45], [0.6, 0.8]],
  [[0.6, 0.8], [0.76, 0.2]],
];

function distToSegment(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function renderIcon(size) {
  const rows = [];
  const strokeWidth = Math.max(1.2, size * 0.105);
  const radius = size * 0.22;

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // 圆角矩形遮罩
      const inX = Math.min(u, 1 - u) * size;
      const inY = Math.min(v, 1 - v) * size;
      const d = Math.hypot(Math.max(0, radius - inX), Math.max(0, radius - inY));
      const bgAlpha = d <= radius ? 1 : 0;
      if (!bgAlpha) {
        row[x * 4 + 3] = 0;
        continue;
      }

      // W 笔画覆盖率
      let cover = 0;
      for (const seg of STROKES) {
        const dist = distToSegment(u * size, v * size, [seg[0][0] * size, seg[0][1] * size], [seg[1][0] * size, seg[1][1] * size]);
        const half = strokeWidth / 2;
        cover = Math.max(cover, Math.min(1, Math.max(0, half + 0.5 - dist)));
      }

      const r = Math.round(BG[0] * (1 - cover) + FG[0] * cover);
      const g = Math.round(BG[1] * (1 - cover) + FG[1] * cover);
      const b = Math.round(BG[2] * (1 - cover) + FG[2] * cover);

      row[x * 4] = r;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = b;
      row[x * 4 + 3] = 255;
    }
    rows.push(Buffer.concat([Buffer.from([0]), row]));
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = deflateSync(Buffer.concat(rows), { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = resolve(OUT_DIR, `${size}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderIcon(size));
  console.log(`wrote ${file}`);
}
