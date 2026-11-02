/**
 * Generate PNG/ICO favicons from the RiskGuard brand SVG.
 *
 *   node scripts/generate-icons.mjs
 *
 * Outputs:
 *   public/favicon.ico        — 16/32/48px multi-size ICO (browser tab)
 *   public/apple-icon.png     — 180px (iOS touch icon)
 *   public/icon-192.png       — PWA icon
 *   public/icon-512.png       — PWA icon (maskable)
 *
 * The source of truth is the shield+trend SVG; keep it in sync with
 * src/components/brand/Logo.tsx and src/app/icon.svg.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const publicDir = join(root, "public");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="rgShield" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#34d399"/>
      <stop offset="1" stop-color="#047857"/>
    </linearGradient>
  </defs>
  <path d="M32 4 56 12.5V30c0 14.4-10.1 25.6-24 30C18.1 55.6 8 44.4 8 30V12.5Z" fill="url(#rgShield)"/>
  <path d="M17 40 25 32l6 5 14-14" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M37 23h8v8" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const svgBuffer = Buffer.from(SVG);

async function renderPng(size, { transparent = true } = {}) {
  const base = await sharp(svgBuffer, { density: 600 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  if (transparent) return base;
  // Solid slate background for maskable/PWA icons.
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 15, g: 23, b: 42, alpha: 1 },
    },
  })
    .composite([{ input: base, gravity: "center" }])
    .png()
    .toBuffer();
}

/** Build a multi-size ICO from PNG buffers (ICO supports PNG-encoded images). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = [];
  const blobs = [];
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // width
    e[1] = size >= 256 ? 0 : size; // height
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
    blobs.push(data);
  }
  return Buffer.concat([header, ...dir, ...blobs]);
}

mkdirSync(publicDir, { recursive: true });

const [i16, i32, i48, apple, i192, i512] = await Promise.all([
  renderPng(16),
  renderPng(32),
  renderPng(48),
  renderPng(180),
  renderPng(192),
  renderPng(512, { transparent: false }),
]);

writeFileSync(join(publicDir, "favicon.ico"), buildIco([
  { size: 16, data: i16 },
  { size: 32, data: i32 },
  { size: 48, data: i48 },
]));
writeFileSync(join(publicDir, "apple-icon.png"), apple);
writeFileSync(join(publicDir, "icon-192.png"), i192);
writeFileSync(join(publicDir, "icon-512.png"), i512);

console.log("Icons written to public/: favicon.ico, apple-icon.png, icon-192.png, icon-512.png");
