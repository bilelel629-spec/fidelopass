/** Formate un nombre avec séparateur de milliers */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat('fr-FR').format(n);
}

/** Formate une date en français */
export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(date));
}

/** Formate une date + heure */
export function formatDateTime(date: string | Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

/** Génère un identifiant court aléatoire */
export function generateShortId(length = 8): string {
  return Math.random().toString(36).substring(2, 2 + length).toUpperCase();
}

/** Classe CSS conditionnelle (mini clsx) */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

/** Calcule le pourcentage de progression (tampons ou points) */
export function calcProgression(actuel: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.round((actuel / total) * 100), 100);
}

/** Vérifie si une couleur hex est valide */
export function isValidHex(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}
