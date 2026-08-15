// Import a custom icon from a source image: cut out the near-white background
// (edge flood-fill + feathering + despill), then write build/icon.png (512,
// transparent) and build/icon.ico (16/32/48/256 PNG-embedded entries), plus a
// checkered preview at workspace/icon-preview.png so you can eyeball the cut.
//
// Usage: node scripts/import-icon.mjs [path/to/source.(jpg|png)]
//   (default: build/icon-source.jpg)
//
// The source image must have a plain near-white background (like a JPEG of an
// anime character on white). Any white areas inside the character are kept —
// only white pixels connected to the image edge are removed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const destBuild = join(root, 'build');
const defaultSrc = join(destBuild, 'icon-source.jpg');
const src = process.argv[2] ?? defaultSrc;

if (!existsSync(src)) {
  console.error(`[import-icon] source not found: ${src}`);
  console.error('  Put your image at build/icon-source.jpg (or pass a path as argv[2]).');
  process.exit(1);
}

const BG_HARD = 24; // pixels this close to white, connected to an edge -> background
const BG_SOFT = 44; // transition band: BG_HARD..BG_SOFT gets feathered alpha

// ---- 1. decode ----
const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
console.log(`[import-icon] decoded ${basename(src)}: ${W}x${H} ch=${C}`);

// ---- 2. edge flood-fill of near-white background ----
const idx = (x, y) => y * W + x;
const dist = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
  dist[i] = Math.max(Math.abs(r - 255), Math.abs(g - 255), Math.abs(b - 255));
}
const isBg = new Uint8Array(W * H);
const queue = [];
const enqueue = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = idx(x, y);
  if (isBg[i] || dist[i] >= BG_HARD) return;
  isBg[i] = 1;
  queue.push(i);
};
for (let x = 0; x < W; x++) { enqueue(x, 0); enqueue(x, H - 1); }
for (let y = 0; y < H; y++) { enqueue(0, y); enqueue(W - 1, y); }
for (let qi = 0; qi < queue.length; qi++) {
  const i = queue[qi];
  const x = i % W, y = (i / W) | 0;
  enqueue(x - 1, y); enqueue(x + 1, y); enqueue(x, y - 1); enqueue(x, y + 1);
}
let bgCount = 0, fgCount = 0;
for (let i = 0; i < W * H; i++) { if (isBg[i]) bgCount++; else fgCount++; }
console.log(`[import-icon] background removed: ${(bgCount / (W * H) * 100).toFixed(1)}% (${bgCount} px)`);

// ---- 3. RGBA with feathered, despilled edges ----
const rgba = Buffer.alloc(W * H * 4);
let trans = 0;
for (let i = 0; i < W * H; i++) {
  const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
  let a;
  if (isBg[i]) {
    a = 0;
  } else if (dist[i] < BG_HARD) {
    a = 255; // enclosed white inside the character: keep
  } else {
    const x = i % W, y = (i / W) | 0;
    const nearBg =
      (x > 0 && isBg[i - 1]) || (x < W - 1 && isBg[i + 1]) ||
      (y > 0 && isBg[i - W]) || (y < H - 1 && isBg[i + W]);
    if (!nearBg) {
      a = 255;
    } else {
      a = Math.round(255 * (1 - (dist[i] - BG_HARD) / (BG_SOFT - BG_HARD)));
      trans++;
    }
  }
  let fr = r, fg = g, fb = b;
  if (a > 0 && a < 255) {
    // despill against assumed white background: fg = (rgb - (1-a)*255) / a
    const k = 255 / a;
    fr = Math.max(0, Math.min(255, Math.round((r - (255 - a)) * k)));
    fg = Math.max(0, Math.min(255, Math.round((g - (255 - a)) * k)));
    fb = Math.max(0, Math.min(255, Math.round((b - (255 - a)) * k)));
  }
  rgba[i * 4] = fr; rgba[i * 4 + 1] = fg; rgba[i * 4 + 2] = fb; rgba[i * 4 + 3] = a;
}
console.log(`[import-icon] feathered transition pixels: ${trans}`);

// ---- 4. smooth alpha (1 pass 3x3 average on transition pixels only) ----
const alpha2 = Buffer.from(rgba);
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const i = idx(x, y);
    const a0 = rgba[i * 4 + 3];
    if (a0 === 0 || a0 === 255) continue;
    const sum =
      rgba[idx(x - 1, y) * 4 + 3] + rgba[idx(x + 1, y) * 4 + 3] +
      rgba[idx(x, y - 1) * 4 + 3] + rgba[idx(x, y + 1) * 4 + 3] +
      rgba[idx(x - 1, y - 1) * 4 + 3] + rgba[idx(x + 1, y - 1) * 4 + 3] +
      rgba[idx(x - 1, y + 1) * 4 + 3] + rgba[idx(x + 1, y + 1) * 4 + 3] + a0;
    alpha2[i * 4 + 3] = Math.round(sum / 9);
  }
}

// ---- 5. outputs ----
const rawOpts = { raw: { width: W, height: H, channels: 4 } };
mkdirSync(destBuild, { recursive: true });

const png512 = await sharp(alpha2, rawOpts).resize(512, 512).png().toBuffer();
writeFileSync(join(destBuild, 'icon.png'), png512);
console.log(`[import-icon] wrote build/icon.png (${png512.length} bytes)`);

// checkered preview so the user can verify the cutout
const checker = Buffer.alloc(512 * 512 * 4);
for (let y = 0; y < 512; y++) {
  for (let x = 0; x < 512; x++) {
    const on = (((x / 16) | 0) % 2) === (((y / 16) | 0) % 2);
    const v = on ? 200 : 230;
    const o = (y * 512 + x) * 4;
    checker[o] = v; checker[o + 1] = v; checker[o + 2] = v; checker[o + 3] = 255;
  }
}
const preview = await sharp(checker, { raw: { width: 512, height: 512, channels: 4 } })
  .composite([{ input: await sharp(alpha2, rawOpts).resize(512, 512).png().toBuffer() }])
  .png()
  .toBuffer();
const previewPath = join(root, 'icon-preview.png');
writeFileSync(previewPath, preview);
console.log(`[import-icon] wrote preview ${previewPath}`);

// icon.ico with 16/32/48/256 PNG entries
const icoSizes = [16, 32, 48, 256];
const entries = [];
const blobs = [];
let offset = 6 + icoSizes.length * 16;
for (const size of icoSizes) {
  const png = await sharp(alpha2, rawOpts).resize(size, size).png().toBuffer();
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  blobs.push(png);
  offset += png.length;
}
const ico = Buffer.concat([Buffer.from([0, 0, 1, 0, icoSizes.length, 0]), ...entries, ...blobs]);
const icoPath = join(destBuild, 'icon.ico');
writeFileSync(icoPath, ico);
console.log(`[import-icon] wrote build/icon.ico (${ico.length} bytes)`);
console.log('[import-icon] DONE — next run `npm run dist` to rebuild the installer.');
