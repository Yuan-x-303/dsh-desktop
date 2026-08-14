#!/usr/bin/env node
// Generate build/icon.png (512px) and build/icon.ico (16/32/48/256) with pure
// Node — no image libraries. The mark is a terminal ">" prompt with a cursor,
// on a dark gradient rounded square.
//
// Usage: node scripts/generate-icon.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'build');
mkdirSync(buildDir, { recursive: true });

// ---- minimal PNG encoder (RGBA, filter 0) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing (2x supersampled, then averaged down for anti-aliasing) ----
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function inRoundedRect(x, y, minx, miny, maxx, maxy, r) {
  const cx = Math.min(Math.max(x, minx + r), maxx - r);
  const cy = Math.min(Math.max(y, miny + r), maxy - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  const ex = px - qx;
  const ey = py - qy;
  return Math.sqrt(ex * ex + ey * ey);
}

function drawIcon(size) {
  const SS = size * 2;
  const hi = Buffer.alloc(SS * SS * 4);
  const s = SS / 512;
  const top = hexToRgb('#262c3d');
  const bottom = hexToRgb('#10131a');
  const white = [255, 255, 255];
  const accent = hexToRgb('#4f8cff');

  const radius = 96 * s;
  const armA = { x: 152 * s, y: 152 * s };
  const armB = { x: 318 * s, y: 256 * s };
  const armC = { x: 152 * s, y: 360 * s };
  const halfW = 22 * s;
  const cursor = { minx: 372 * s, miny: 208 * s, maxx: 406 * s, maxy: 304 * s, r: 10 * s };

  for (let y = 0; y < SS; y++) {
    for (let x = 0; x < SS; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (inRoundedRect(x, y, 0, 0, SS, SS, radius)) {
        const t = y / SS;
        r = top[0] + (bottom[0] - top[0]) * t;
        g = top[1] + (bottom[1] - top[1]) * t;
        b = top[2] + (bottom[2] - top[2]) * t;
        a = 255;
      }
      const d1 = segDist(x, y, armA.x, armA.y, armB.x, armB.y);
      const d2 = segDist(x, y, armC.x, armC.y, armB.x, armB.y);
      if (Math.min(d1, d2) <= halfW) {
        r = white[0];
        g = white[1];
        b = white[2];
        a = 255;
      }
      if (inRoundedRect(x, y, cursor.minx, cursor.miny, cursor.maxx, cursor.maxy, cursor.r)) {
        r = accent[0];
        g = accent[1];
        b = accent[2];
        a = 255;
      }
      const i = (y * SS + x) * 4;
      hi[i] = r;
      hi[i + 1] = g;
      hi[i + 2] = b;
      hi[i + 3] = a;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0;
      let G = 0;
      let B = 0;
      let A = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const si = ((y * 2 + dy) * SS + (x * 2 + dx)) * 4;
          R += hi[si];
          G += hi[si + 1];
          B += hi[si + 2];
          A += hi[si + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = R / 4;
      out[o + 1] = G / 4;
      out[o + 2] = B / 4;
      out[o + 3] = A / 4;
    }
  }
  return out;
}

// ---- ICO container (PNG-embedded entries) ----
function packIco(sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);

  let offset = 6 + sizes.length * 16;
  const entries = [];
  const blobs = [];
  for (const { size, png } of sizes) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

const icoSizes = [16, 32, 48, 256];
const icoEntries = icoSizes.map((size) => ({
  size,
  png: encodePng(size, size, drawIcon(size)),
}));

writeFileSync(join(buildDir, 'icon.png'), encodePng(512, 512, drawIcon(512)));
writeFileSync(join(buildDir, 'icon.ico'), packIco(icoEntries));
console.log('[generate-icon] wrote build/icon.png and build/icon.ico');
