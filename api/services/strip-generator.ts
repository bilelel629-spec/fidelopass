/**
 * Génère l'image "strip" (bannière) du pass Apple Wallet.
 * Supporte : fond uni, dégradé, patterns SVG, grille équilibrée de tampons, emojis.
 */
import sharp from 'sharp';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface StripOptions {
  type: 'tampons' | 'points';
  tamponsActuels: number;
  tamponsTotal: number;
  couleurFond: string;
  couleurAccent: string;
  stripImageUrl?: string | null;
  stripPosition?: string | null;
  tamponIconUrl?: string | null;
  // Avancé
  couleurFond2?: string | null;
  gradientAngle?: number | null;
  patternType?: string | null;
  tamponEmoji?: string | null;
  stripLayout?: string | null;
  showBranding?: boolean;
}

const BRANDING_WATERMARK_PATHS = [
  resolve(process.cwd(), 'public/logo-premium-cropped.png'),
  resolve(process.cwd(), 'assets/pass/logo.png'),
];

let brandingWatermarkCache: Buffer | null | undefined;

function loadBrandingWatermark(): Buffer | null {
  if (brandingWatermarkCache !== undefined) return brandingWatermarkCache;
  for (const filePath of BRANDING_WATERMARK_PATHS) {
    if (!existsSync(filePath)) continue;
    try {
      brandingWatermarkCache = readFileSync(filePath);
      return brandingWatermarkCache;
    } catch {
      // Try the next path.
    }
  }
  brandingWatermarkCache = null;
  return null;
}

// Hex → { r, g, b }
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.replace('#', '');
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

function parseStripFocus(raw: string | null | undefined): { x: number; y: number; legacy: 'top' | 'center' | 'bottom' } {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return { x: 50, y: 50, legacy: 'center' };
  if (value === 'top') return { x: 50, y: 0, legacy: 'top' };
  if (value === 'bottom') return { x: 50, y: 100, legacy: 'bottom' };
  if (value === 'center') return { x: 50, y: 50, legacy: 'center' };
  const match = value.match(/^(\d{1,3}(?:\.\d+)?):(\d{1,3}(?:\.\d+)?)$/);
  if (!match) return { x: 50, y: 50, legacy: 'center' };
  const x = Math.max(0, Math.min(100, Number(match[1])));
  const y = Math.max(0, Math.min(100, Number(match[2])));
  return { x, y, legacy: 'center' };
}

async function cropImageToFocus(
  buffer: Buffer,
  targetWidth: number,
  targetHeight: number,
  focus: { x: number; y: number; legacy: 'top' | 'center' | 'bottom' },
): Promise<Buffer> {
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    const legacyPos = focus.legacy === 'top' ? 'top' : focus.legacy === 'bottom' ? 'bottom' : 'centre';
    return sharp(buffer).resize(targetWidth, targetHeight, { fit: 'cover', position: legacyPos }).png().toBuffer();
  }

  const scaleByWidth = (targetWidth / metadata.width) >= (targetHeight / metadata.height);
  const resized = scaleByWidth
    ? await sharp(buffer).resize({ width: targetWidth }).png().toBuffer({ resolveWithObject: true })
    : await sharp(buffer).resize({ height: targetHeight }).png().toBuffer({ resolveWithObject: true });

  const sourceWidth = resized.info.width ?? targetWidth;
  const sourceHeight = resized.info.height ?? targetHeight;
  const maxLeft = Math.max(0, sourceWidth - targetWidth);
  const maxTop = Math.max(0, sourceHeight - targetHeight);
  const left = Math.max(0, Math.min(maxLeft, Math.round((focus.x / 100) * maxLeft)));
  const top = Math.max(0, Math.min(maxTop, Math.round((focus.y / 100) * maxTop)));

  return sharp(resized.data)
    .extract({ left, top, width: targetWidth, height: targetHeight })
    .png()
    .toBuffer();
}

async function applyBrandingWatermark(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  const source = loadBrandingWatermark();
  if (!source) return buffer;

  try {
    const watermarkWidth = Math.max(92, Math.round(width * 0.22));
    const resized = await sharp(source).resize({ width: watermarkWidth }).png().toBuffer();
    const resizedMeta = await sharp(resized).metadata();
    const renderedWidth = resizedMeta.width ?? watermarkWidth;
    const renderedHeight = resizedMeta.height ?? Math.round(height * 0.12);
    const paddingX = Math.max(10, Math.round(width * 0.018));
    const paddingY = Math.max(8, Math.round(height * 0.04));
    const left = Math.max(0, width - renderedWidth - paddingX);
    const top = Math.max(0, height - renderedHeight - paddingY);
    const dataUri = resized.toString('base64');
    const overlay = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <image href="data:image/png;base64,${dataUri}" x="${left}" y="${top}" width="${renderedWidth}" height="${renderedHeight}" opacity="0.33"/>
      </svg>
    `);

    return sharp(buffer)
      .composite([{ input: overlay, blend: 'over' }])
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
}

/** Colonnes optimales pour une grille équilibrée */
function stampCols(total: number): number {
  if (total <= 6) return total;                    // 1–6 : ligne unique
  if (total <= 12) return Math.ceil(total / 2);   // 7–12 : 2 lignes équilibrées
  if (total <= 15) return 5;                       // 13–15 : lignes de 5
  return 6;                                        // 16+ : lignes de 6
}

/** SVG defs : dégradé linéaire */
function gradientDef(fond: string, fond2: string, angle: number): string {
  const { r: r1, g: g1, b: b1 } = hexToRgb(fond);
  const { r: r2, g: g2, b: b2 } = hexToRgb(fond2);
  const rad = ((angle - 90) * Math.PI) / 180;
  const x1 = Math.round((0.5 - Math.cos(rad) * 0.5) * 100);
  const y1 = Math.round((0.5 - Math.sin(rad) * 0.5) * 100);
  const x2 = Math.round((0.5 + Math.cos(rad) * 0.5) * 100);
  const y2 = Math.round((0.5 + Math.sin(rad) * 0.5) * 100);
  return `<defs>
    <linearGradient id="bg" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">
      <stop offset="0%" stop-color="rgb(${r1},${g1},${b1})"/>
      <stop offset="100%" stop-color="rgb(${r2},${g2},${b2})"/>
    </linearGradient>
  </defs>`;
}

/** SVG defs + rect : pattern de fond */
function patternOverlay(type: string, W: number, H: number, accent: string): string {
  const { r, g, b } = hexToRgb(accent);
  switch (type) {
    case 'dots':
      return `<defs>
        <pattern id="pat" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="12" cy="12" r="2.5" fill="rgba(${r},${g},${b},0.18)"/>
        </pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#pat)"/>`;
    case 'grid':
      return `<defs>
        <pattern id="pat" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(${r},${g},${b},0.15)" stroke-width="0.6"/>
        </pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#pat)"/>`;
    case 'waves':
      return `<defs>
        <pattern id="pat" x="0" y="0" width="48" height="24" patternUnits="userSpaceOnUse">
          <path d="M 0 12 Q 12 0 24 12 Q 36 24 48 12" fill="none" stroke="rgba(${r},${g},${b},0.18)" stroke-width="1.2"/>
        </pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#pat)"/>`;
    case 'diagonal':
      return `<defs>
        <pattern id="pat" x="0" y="0" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <rect x="0" y="0" width="5" height="28" fill="rgba(${r},${g},${b},0.16)"/>
        </pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#pat)"/>`;
    case 'confetti':
      return `<defs>
        <pattern id="pat" x="0" y="0" width="54" height="54" patternUnits="userSpaceOnUse">
          <circle cx="10" cy="12" r="3" fill="rgba(${r},${g},${b},0.18)"/>
          <rect x="31" y="8" width="12" height="4" rx="2" transform="rotate(25 37 10)" fill="rgba(${r},${g},${b},0.16)"/>
          <circle cx="42" cy="38" r="2.5" fill="rgba(${r},${g},${b},0.2)"/>
          <rect x="14" y="36" width="10" height="4" rx="2" transform="rotate(-28 19 38)" fill="rgba(${r},${g},${b},0.15)"/>
        </pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#pat)"/>`;
    default:
      return '';
  }
}

type TamponLayout = 'background' | 'top' | 'bottom';

interface StampDot {
  cx: number;
  cy: number;
  filled: boolean;
}

function normalizeTamponLayout(value: string | null | undefined): TamponLayout {
  if (value === 'top' || value === 'bottom') return value;
  return 'background';
}

function computeStampGrid(total: number, current: number, W: number, H: number, layout: TamponLayout): { dots: StampDot[]; radius: number } {
  const displayTotal = Math.max(1, Math.min(total, 12));
  const cols = stampCols(displayTotal);
  const rows = Math.ceil(displayTotal / cols);
  const radius = Math.min(26, Math.floor((W * 0.65) / (cols * 2.8)));
  const spacingX = radius * 2.8;
  const spacingY = radius * 2.8;
  const totalW = cols * spacingX - spacingX + radius * 2;
  const totalH = rows * spacingY - spacingY + radius * 2;
  const startX = (W - totalW) / 2 + radius;
  const startY = layout === 'top'
    ? H - totalH - 18 + radius
    : layout === 'bottom'
      ? 18 + radius
      : (H - totalH) / 2 + radius;

  const normalizedCurrent = Math.max(0, Math.min(current, displayTotal));
  const dots: StampDot[] = Array.from({ length: displayTotal }, (_, i) => ({
    cx: startX + (i % cols) * spacingX,
    cy: startY + Math.floor(i / cols) * spacingY,
    filled: i < normalizedCurrent,
  }));
  return { dots, radius };
}

async function buildBaseStripBackground(opts: StripOptions, W: number, H: number): Promise<Buffer> {
  const fnd = hexToRgb(opts.couleurFond);
  const hasDeg = !!opts.couleurFond2;
  const defs = hasDeg ? gradientDef(opts.couleurFond, opts.couleurFond2!, opts.gradientAngle ?? 135) : '';
  const bgFill = hasDeg ? 'url(#bg)' : `rgb(${fnd.r},${fnd.g},${fnd.b})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${defs}
    <rect width="${W}" height="${H}" fill="${bgFill}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function applyPatternOverlay(base: Buffer, patternType: string | null | undefined, accentColor: string, W: number, H: number): Promise<Buffer> {
  if (!patternType || patternType === 'none') return base;
  const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${patternOverlay(patternType, W, H, accentColor)}
  </svg>`;
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: 'over' }])
    .png()
    .toBuffer();
}

async function prepareCircularTamponIcon(iconUrl: string | null | undefined, diameter: number): Promise<Buffer | null> {
  if (!iconUrl) return null;
  const source = await fetchBuffer(iconUrl);
  if (!source) return null;

  try {
    const size = Math.max(18, Math.round(diameter));
    const inner = Math.max(12, Math.round(size * 0.74));
    const trimmed = await sharp(source).trim().png().toBuffer();
    const contained = await sharp(trimmed)
      .resize(inner, inner, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    const canvas = await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: contained, gravity: 'centre' }])
      .png()
      .toBuffer();

    const mask = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
      </svg>
    `);
    return sharp(canvas).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  } catch {
    return null;
  }
}

function buildTamponCirclesSvg(W: number, H: number, accentHex: string, dots: StampDot[], radius: number, emoji: string | null | undefined, hasCustomIcon: boolean, useLightStyle: boolean): string {
  const acc = hexToRgb(accentHex);
  const ringStroke = useLightStyle
    ? 'rgba(255,255,255,0.62)'
    : `rgba(${acc.r},${acc.g},${acc.b},0.45)`;
  const ringFill = hasCustomIcon
    ? 'rgba(255,255,255,0.12)'
    : (useLightStyle ? 'rgba(255,255,255,0.2)' : 'none');

  const circles = dots.map((dot) => {
    const cx = Math.round(dot.cx * 100) / 100;
    const cy = Math.round(dot.cy * 100) / 100;

    if (dot.filled) {
      const inner = hasCustomIcon
        ? ''
        : (emoji
          ? `<text x="${cx}" y="${cy + radius * 0.38}" text-anchor="middle" font-size="${radius * 1.1}" dominant-baseline="middle">${emoji}</text>`
          : `<polyline points="${cx - radius * 0.45},${cy} ${cx - radius * 0.1},${cy + radius * 0.38} ${cx + radius * 0.48},${cy - radius * 0.32}"
              stroke="white" stroke-width="${radius * 0.18}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
      return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="rgba(${acc.r},${acc.g},${acc.b},0.94)"/>${inner}`;
    }

    return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${ringFill}"
      stroke="${ringStroke}" stroke-width="${radius * 0.12}"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${circles}</svg>`;
}

async function composeTamponGrid(base: Buffer, opts: StripOptions, W: number, H: number, layout: TamponLayout, useLightStyle: boolean): Promise<Buffer> {
  const { dots, radius } = computeStampGrid(opts.tamponsTotal, opts.tamponsActuels, W, H, layout);
  const iconSize = Math.max(18, Math.round(radius * 1.42));
  const iconBuffer = await prepareCircularTamponIcon(opts.tamponIconUrl, iconSize);

  const overlaySvg = buildTamponCirclesSvg(
    W,
    H,
    opts.couleurAccent,
    dots,
    radius,
    opts.tamponEmoji,
    !!iconBuffer,
    useLightStyle,
  );

  const composites: sharp.OverlayOptions[] = [
    { input: Buffer.from(overlaySvg), blend: 'over' },
  ];

  if (iconBuffer) {
    for (const dot of dots) {
      composites.push({
        input: iconBuffer,
        left: Math.round(dot.cx - iconSize / 2),
        top: Math.round(dot.cy - iconSize / 2),
        blend: 'over',
        opacity: dot.filled ? 1 : 0.34,
      });
    }
  }

  return sharp(base).composite(composites).png().toBuffer();
}

export async function generateStripImage(opts: StripOptions): Promise<Buffer> {
  const W = 750;
  const H = 246;
  const focus = parseStripFocus(opts.stripPosition);
  const withBranding = opts.showBranding !== false;

  if (opts.type === 'points') {
    if (opts.stripImageUrl) {
      const buf = await fetchBuffer(opts.stripImageUrl);
      if (buf) {
        const cropped = await cropImageToFocus(buf, W, H, focus);
        return withBranding ? applyBrandingWatermark(cropped, W, H) : cropped;
      }
    }
    const fnd = hexToRgb(opts.couleurFond);
    const acc = hexToRgb(opts.couleurAccent);
    const hasDeg = !!opts.couleurFond2;
    const defs = hasDeg ? gradientDef(opts.couleurFond, opts.couleurFond2!, opts.gradientAngle ?? 135) : '';
    const bgFill = hasDeg ? 'url(#bg)' : `rgb(${fnd.r},${fnd.g},${fnd.b})`;
    const pat = patternOverlay(opts.patternType ?? 'none', W, H, opts.couleurAccent);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      ${defs}
      <rect width="${W}" height="${H}" fill="${bgFill}"/>
      ${pat}
      <rect x="${W*0.1}" y="${H*0.55}" width="${W*0.8}" height="8" rx="4" fill="rgba(255,255,255,0.2)"/>
      <rect x="${W*0.1}" y="${H*0.55}" width="0" height="8" rx="4" fill="rgb(${acc.r},${acc.g},${acc.b})"/>
    </svg>`;
    const generated = await sharp(Buffer.from(svg)).png().toBuffer();
    return withBranding ? applyBrandingWatermark(generated, W, H) : generated;
  }

  // Type tampons
  try {
    const layout = normalizeTamponLayout(opts.stripLayout);
    let base = await buildBaseStripBackground(opts, W, H);

    if (opts.stripImageUrl) {
      const bgBuf = await fetchBuffer(opts.stripImageUrl);
      if (bgBuf) {
        if (layout === 'top' || layout === 'bottom') {
          const bannerH = Math.round(H * 0.42);
          const banner = await cropImageToFocus(bgBuf, W, bannerH, focus);
          base = await sharp(base)
            .composite([{ input: banner, left: 0, top: layout === 'top' ? 0 : H - bannerH }])
            .png()
            .toBuffer();
        } else {
          base = await cropImageToFocus(bgBuf, W, H, focus);
        }
      }
    }

    base = await applyPatternOverlay(base, opts.patternType, opts.couleurAccent, W, H);
    const composed = await composeTamponGrid(base, opts, W, H, layout, !!opts.stripImageUrl);
    return withBranding ? applyBrandingWatermark(composed, W, H) : composed;
  } catch {
    const fallbackBase = await applyPatternOverlay(
      await buildBaseStripBackground(opts, W, H),
      opts.patternType,
      opts.couleurAccent,
      W,
      H,
    );
    const fallback = await composeTamponGrid(fallbackBase, opts, W, H, 'background', false);
    return withBranding ? applyBrandingWatermark(fallback, W, H) : fallback;
  }
}
