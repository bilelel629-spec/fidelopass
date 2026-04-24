export type PatternBackground = {
  image: string;
  size: string;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function stampCols(total: number): number {
  if (total <= 6) return total;
  if (total <= 12) return Math.ceil(total / 2);
  if (total <= 15) return 5;
  return 6;
}

function hexToRgb(hex: string): string {
  const normalized = hex.replace('#', '').trim();
  if (normalized.length !== 6) return '99,102,241';
  return `${parseInt(normalized.slice(0, 2), 16)},${parseInt(normalized.slice(2, 4), 16)},${parseInt(normalized.slice(4, 6), 16)}`;
}

export function getPatternBackground(patternType: string, accentHex: string): PatternBackground {
  const rgb = hexToRgb(accentHex);
  if (patternType === 'dots') {
    return {
      image: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='2' fill='rgba(${encodeURIComponent(rgb)},0.18)'/%3E%3C/svg%3E")`,
      size: '24px 24px',
    };
  }
  if (patternType === 'grid') {
    return {
      image: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M 24 0 L 0 0 0 24' fill='none' stroke='rgba(${encodeURIComponent(rgb)},0.15)' stroke-width='0.6'/%3E%3C/svg%3E")`,
      size: '24px 24px',
    };
  }
  if (patternType === 'waves') {
    return {
      image: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='24'%3E%3Cpath d='M 0 12 Q 12 0 24 12 Q 36 24 48 12' fill='none' stroke='rgba(${encodeURIComponent(rgb)},0.2)' stroke-width='1.2'/%3E%3C/svg%3E")`,
      size: '48px 24px',
    };
  }
  if (patternType === 'diagonal') {
    return {
      image: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Cdefs%3E%3Cpattern id='p' width='28' height='28' patternUnits='userSpaceOnUse' patternTransform='rotate(35)'%3E%3Crect width='5' height='28' fill='rgba(${encodeURIComponent(rgb)},0.16)'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='28' height='28' fill='url(%23p)'/%3E%3C/svg%3E")`,
      size: '28px 28px',
    };
  }
  if (patternType === 'confetti') {
    return {
      image: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='54' height='54'%3E%3Ccircle cx='10' cy='12' r='3' fill='rgba(${encodeURIComponent(rgb)},0.18)'/%3E%3Crect x='31' y='8' width='12' height='4' rx='2' transform='rotate(25 37 10)' fill='rgba(${encodeURIComponent(rgb)},0.16)'/%3E%3Ccircle cx='42' cy='38' r='2.5' fill='rgba(${encodeURIComponent(rgb)},0.2)'/%3E%3Crect x='14' y='36' width='10' height='4' rx='2' transform='rotate(-28 19 38)' fill='rgba(${encodeURIComponent(rgb)},0.15)'/%3E%3C/svg%3E")`,
      size: '54px 54px',
    };
  }
  return { image: 'none', size: 'auto' };
}
