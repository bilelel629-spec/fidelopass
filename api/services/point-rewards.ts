export type RewardTier = {
  seuil: number;
  recompense: string;
};

export type PointRewardProgram = {
  points_recompense?: number | null;
  recompense_description?: string | null;
  rewards_multi_enabled?: boolean | null;
  rewards_config?: unknown;
};

export type PointRewardCatalogItem = RewardTier & {
  disponible: boolean;
  points_manquants: number;
};

export type PointRewardState = {
  points_actuels: number;
  reward_catalog: PointRewardCatalogItem[];
  available_rewards: PointRewardCatalogItem[];
  next_reward: PointRewardCatalogItem | null;
  can_use_reward: boolean;
};

export type PointRewardRedemptionResult =
  | {
      ok: true;
      reward: RewardTier;
      points_before: number;
      points_after: number;
    }
  | {
      ok: false;
      reason: 'NO_REWARD_AVAILABLE' | 'REWARD_SELECTION_REQUIRED' | 'REWARD_NOT_FOUND' | 'INSUFFICIENT_POINTS';
    };

function toSafeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function normalizeRewardTiers(raw: unknown): RewardTier[] {
  if (!Array.isArray(raw)) return [];

  const byThreshold = new Map<number, RewardTier>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const seuil = toSafeInteger((item as { seuil?: unknown }).seuil);
    const recompense = String((item as { recompense?: unknown }).recompense ?? '').trim();
    if (seuil <= 0 || !recompense) continue;
    if (!byThreshold.has(seuil)) byThreshold.set(seuil, { seuil, recompense });
  }

  return Array.from(byThreshold.values()).sort((left, right) => left.seuil - right.seuil);
}

export function getPointRewardTiers(program: PointRewardProgram): RewardTier[] {
  if (program.rewards_multi_enabled === true) {
    const configured = normalizeRewardTiers(program.rewards_config);
    if (configured.length > 0) return configured;
  }

  const legacyThreshold = Math.max(1, toSafeInteger(program.points_recompense) || 100);
  const legacyLabel = String(program.recompense_description ?? '').trim() || 'Récompense fidélité';
  return [{ seuil: legacyThreshold, recompense: legacyLabel }];
}

export function getPointRewardState(
  points: number | null | undefined,
  program: PointRewardProgram,
): PointRewardState {
  const pointsActuels = toSafeInteger(points);
  const rewardCatalog = getPointRewardTiers(program).map((reward) => ({
    ...reward,
    disponible: pointsActuels >= reward.seuil,
    points_manquants: Math.max(0, reward.seuil - pointsActuels),
  }));
  const availableRewards = rewardCatalog.filter((reward) => reward.disponible);
  const nextReward = rewardCatalog.find((reward) => !reward.disponible) ?? null;

  return {
    points_actuels: pointsActuels,
    reward_catalog: rewardCatalog,
    available_rewards: availableRewards,
    next_reward: nextReward,
    can_use_reward: availableRewards.length > 0,
  };
}

export function getNewlyAvailablePointRewards(
  pointsBefore: number,
  pointsAfter: number,
  program: PointRewardProgram,
): RewardTier[] {
  const before = toSafeInteger(pointsBefore);
  const after = toSafeInteger(pointsAfter);
  if (after <= before) return [];

  return getPointRewardTiers(program).filter((reward) => before < reward.seuil && after >= reward.seuil);
}

export function resolvePointRewardRedemption(
  points: number | null | undefined,
  program: PointRewardProgram,
  requestedThreshold?: number | null,
): PointRewardRedemptionResult {
  const state = getPointRewardState(points, program);
  if (state.available_rewards.length === 0) {
    return { ok: false, reason: 'NO_REWARD_AVAILABLE' };
  }

  let selected: PointRewardCatalogItem | undefined;
  if (requestedThreshold != null) {
    const threshold = toSafeInteger(requestedThreshold);
    selected = state.reward_catalog.find((reward) => reward.seuil === threshold);
    if (!selected) return { ok: false, reason: 'REWARD_NOT_FOUND' };
    if (!selected.disponible) return { ok: false, reason: 'INSUFFICIENT_POINTS' };
  } else if (state.available_rewards.length === 1) {
    [selected] = state.available_rewards;
  } else {
    return { ok: false, reason: 'REWARD_SELECTION_REQUIRED' };
  }

  return {
    ok: true,
    reward: { seuil: selected.seuil, recompense: selected.recompense },
    points_before: state.points_actuels,
    points_after: state.points_actuels - selected.seuil,
  };
}
