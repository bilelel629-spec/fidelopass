/**
 * Génère l'image "strip" (bannière) du pass Apple Wallet.
 * Supporte : fond uni, dégradé, patterns SVG, grille équilibrée de tampons, emojis.
 */
import sharp from 'sharp';

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
  const fontSize = Math.max(11, Math.round(height * 0.07));
  const overlay = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <text x="${width - 14}" y="${height - 10}" text-anchor="end"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${fontSize}" letter-spacing="1.2"
        fill="rgba(255,255,255,0.5)">Propulsé par Fidelopass</text>
    </svg>
  `);

  return sharp(buffer)
    .composite([{ input: overlay, blend: 'over' }])
    .png()
    .toBuffer();
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

/** Génère un SVG représentant la grille de tampons */
function buildStampSvg(opts: {
  width: number;
  height: number;
  total: number;
  current: number;
  accentHex: string;
  fondHex: string;
  fondHex2?: string | null;
  gradientAngle?: number;
  patternType?: string | null;
  emoji?: string | null;
}): string {
  const { width: W, height: H, total, current, accentHex, fondHex, fondHex2, patternType, emoji } = opts;
  const angle = opts.gradientAngle ?? 135;
  const acc = hexToRgb(accentHex);
  const fnd = hexToRgb(fondHex);

  // Fond : dégradé ou couleur unie
  const hasDeg = !!fondHex2;
  const defs = hasDeg ? gradientDef(fondHex, fondHex2!, angle) : '';
  const bgFill = hasDeg ? 'url(#bg)' : `rgb(${fnd.r},${fnd.g},${fnd.b})`;

  // Disposition équilibrée
  const cols = stampCols(Math.min(total, 12));
  const rows = Math.ceil(Math.min(total, 12) / cols);
  const r = Math.min(26, Math.floor((W * 0.7) / (cols * 2.8)));
  const spacingX = r * 2.8;
  const spacingY = r * 2.8;
  const totalW = cols * spacingX - spacingX + r * 2;
  const totalH = rows * spacingY - spacingY + r * 2;
  const startX = (W - totalW) / 2 + r;
  const startY = (H - totalH) / 2 + r;

  const display = Math.min(total, 12);
  const circles = Array.from({ length: display }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = startX + col * spacingX;
    const cy = startY + row * spacingY;
    const filled = i < current;

    if (filled) {
      const inner = emoji
        ? `<text x="${cx}" y="${cy + r * 0.38}" text-anchor="middle" font-size="${r * 1.1}" dominant-baseline="middle">${emoji}</text>`
        : `<polyline points="${cx - r*0.45},${cy} ${cx - r*0.1},${cy + r*0.38} ${cx + r*0.48},${cy - r*0.32}"
            stroke="white" stroke-width="${r * 0.2}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgb(${acc.r},${acc.g},${acc.b})"/>
        ${inner}`;
    }
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="rgba(${acc.r},${acc.g},${acc.b},0.45)" stroke-width="${r * 0.15}"/>`;
  }).join('');

  const pat = patternOverlay(patternType ?? 'none', W, H, accentHex);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${defs}
    <rect width="${W}" height="${H}" fill="${bgFill}"/>
    ${pat}
    ${circles}
  </svg>`;
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
  if (opts.stripImageUrl) {
    const bgBuf = await fetchBuffer(opts.stripImageUrl);
    if (bgBuf) {
      try {
        let bg: Buffer;
        const layout = opts.stripLayout ?? 'background';
        if (layout === 'top' || layout === 'bottom') {
          const bannerH = Math.round(H * 0.42);
          const banner = await cropImageToFocus(bgBuf, W, bannerH, focus);
          const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
            <rect width="${W}" height="${H}" fill="${opts.couleurFond}"/>
            ${patternOverlay(opts.patternType ?? 'none', W, H, opts.couleurAccent)}
          </svg>`;
          bg = await sharp(Buffer.from(baseSvg))
            .composite([{ input: banner, left: 0, top: layout === 'top' ? 0 : H - bannerH }])
            .png()
            .toBuffer();
        } else {
          bg = await cropImageToFocus(bgBuf, W, H, focus);
        }
        const acc = hexToRgb(opts.couleurAccent);
        const cols = stampCols(opts.tamponsTotal);
        const rows = Math.ceil(opts.tamponsTotal / cols);
        const r = Math.min(26, Math.floor((W * 0.65) / (cols * 2.8)));
        const spacingX = r * 2.8;
        const spacingY = r * 2.8;
        const totalW = cols * spacingX - spacingX + r * 2;
        const totalH = rows * spacingY - spacingY + r * 2;
        const startX = (W - totalW) / 2 + r;
        const stampLayout = opts.stripLayout ?? 'background';
        const startY = stampLayout === 'top'
          ? H - totalH - 18 + r
          : stampLayout === 'bottom'
            ? 18 + r
            : (H - totalH) / 2 + r;

        const circles = Array.from({ length: opts.tamponsTotal }, (_, i) => {
          const cx = startX + (i % cols) * spacingX;
          const cy = startY + Math.floor(i / cols) * spacingY;
          const filled = i < opts.tamponsActuels;
          if (filled) {
            const inner = opts.tamponEmoji
              ? `<text x="${cx}" y="${cy + r*0.38}" text-anchor="middle" font-size="${r*1.1}" dominant-baseline="middle">${opts.tamponEmoji}</text>`
              : `<polyline points="${cx - r*0.45},${cy} ${cx - r*0.1},${cy + r*0.38} ${cx + r*0.48},${cy - r*0.32}"
                  stroke="white" stroke-width="${r*0.18}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(${acc.r},${acc.g},${acc.b},0.9)"/>${inner}`;
          }
          return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(255,255,255,0.25)"
            stroke="rgba(255,255,255,0.6)" stroke-width="${r*0.12}"/>`;
        }).join('');

        const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${circles}</svg>`;
        const overlayBuf = await sharp(Buffer.from(overlaySvg)).png().toBuffer();
        const composed = await sharp(bg).composite([{ input: overlayBuf, blend: 'over' }]).png().toBuffer();
        return withBranding ? applyBrandingWatermark(composed, W, H) : composed;
      } catch { /* fallback ci-dessous */ }
    }
  }

  // Pas d'image custom : SVG pur avec dégradé + pattern + tampons
  const svg = buildStampSvg({
    width: W, height: H,
    total: Math.min(opts.tamponsTotal, 12),
    current: opts.tamponsActuels,
    accentHex: opts.couleurAccent,
    fondHex: opts.couleurFond,
    fondHex2: opts.couleurFond2,
    gradientAngle: opts.gradientAngle ?? 135,
    patternType: opts.patternType,
    emoji: opts.tamponEmoji,
  });
  const fallback = await sharp(Buffer.from(svg)).png().toBuffer();
  return withBranding ? applyBrandingWatermark(fallback, W, H) : fallback;
}
