/**
 * Génère les PNG requis pour un Apple Wallet .pkpass
 * Usage : node scripts/generate-pass-assets.mjs
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { deflateSync } from 'zlib';

const OUT_DIR = resolve(process.cwd(), 'assets/pass');
mkdirSync(OUT_DIR, { recursive: true });

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = ((crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function makePng(w, h, r, g, b) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  ihdrData[8] = 8; ihdrData[9] = 2; // 8-bit RGB

  // Données image brutes (filtre 0 par ligne + RGB)
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const offset = y * (1 + w * 3);
    raw[offset] = 0; // filtre None
    for (let x = 0; x < w; x++) {
      raw[offset + 1 + x * 3] = r;
      raw[offset + 1 + x * 3 + 1] = g;
      raw[offset + 1 + x * 3 + 2] = b;
    }
  }

  const compressed = deflateSync(raw);
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Indigo #6366f1 → rgb(99, 102, 241)
const [R, G, B] = [99, 102, 241];

const assets = [
  { name: 'icon.png',     w: 29,  h: 29  },
  { name: 'icon@2x.png',  w: 58,  h: 58  },
  { name: 'icon@3x.png',  w: 87,  h: 87  },
  { name: 'logo.png',     w: 160, h: 50  },
  { name: 'logo@2x.png',  w: 320, h: 100 },
  { name: 'strip.png',    w: 375, h: 98  },
  { name: 'strip@2x.png', w: 750, h: 196 },
];

for (const { name, w, h } of assets) {
  writeFileSync(resolve(OUT_DIR, name), makePng(w, h, R, G, B));
  console.log(`✓ ${name} (${w}×${h})`);
}

console.log(`\nAssets générés dans : assets/pass/`);
