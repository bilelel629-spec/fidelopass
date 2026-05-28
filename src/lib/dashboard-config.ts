export const DASHBOARD_V2_ENABLED = (import.meta.env.PUBLIC_DASHBOARD_V2_ENABLED ?? 'true') !== 'false';
export const CARD_WIZARD_V2_ENABLED = (import.meta.env.PUBLIC_CARD_WIZARD_V2_ENABLED ?? 'true') !== 'false';

export function normalizePlan(planRaw: unknown): string {
  return String(planRaw ?? 'starter').trim().toLowerCase();
}

export function isProPlan(planRaw: unknown): boolean {
  const normalized = normalizePlan(planRaw);
  return normalized === 'pro'
    || normalized.startsWith('pro-')
    || normalized.includes('pro')
    || normalized === 'business'
    || normalized.startsWith('business-')
    || normalized.includes('business');
}

export function isBusinessPlan(planRaw: unknown): boolean {
  const normalized = normalizePlan(planRaw);
  return normalized === 'business' || normalized.startsWith('business-') || normalized.includes('business');
}

export function isCustomPlan(planRaw: unknown): boolean {
  const normalized = normalizePlan(planRaw);
  return normalized.includes('sur-mesure') || normalized.includes('surmesure') || normalized.includes('custom') || normalized.includes('enterprise');
}

export function planLabel(planRaw: unknown): 'STARTER' | 'PRO' | 'BUSINESS' | 'SUR MESURE' {
  if (isCustomPlan(planRaw)) return 'SUR MESURE';
  if (isBusinessPlan(planRaw)) return 'BUSINESS';
  if (isProPlan(planRaw)) return 'PRO';
  return 'STARTER';
}

export function planBadgeClass(planRaw: unknown): string {
  const label = planLabel(planRaw);
  if (label === 'SUR MESURE') {
    return 'inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[0.67rem] font-semibold tracking-wide text-sky-700';
  }
  if (label === 'PRO') {
    return 'inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[0.67rem] font-semibold tracking-wide text-violet-700';
  }
  if (label === 'BUSINESS') {
    return 'inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[0.67rem] font-semibold tracking-wide text-blue-700';
  }
  return 'inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[0.67rem] font-semibold tracking-wide text-emerald-700';
}
