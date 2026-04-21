export type CommercePlanContext = {
  plan?: string | null;
  plan_override?: string | null;
};

export function getEffectivePlanRaw(context: CommercePlanContext | null | undefined): string {
  const override = String(context?.plan_override ?? '').trim();
  if (override.length > 0) return override;
  return String(context?.plan ?? 'starter');
}

