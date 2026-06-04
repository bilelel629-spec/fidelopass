export type LoyaltyProgramType = 'points' | 'tampons';

export type LoyaltyCarteLike = {
  type?: string | null;
  points_recompense?: number | null;
  tampons_total?: number | null;
};

export type LoyaltyClientLike = {
  points_actuels?: number | null;
  tampons_actuels?: number | null;
  recompenses_obtenues?: number | null;
};

export type LoyaltyProgressResult = {
  newPoints: number;
  newTampons: number;
  recompensesObtenues: number;
  activeScoreBefore: number;
  activeScoreAfter: number;
  rewardsEarned: number;
};

function asPositiveInteger(value: unknown, fallback = 0): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.trunc(numberValue));
}

export function getProgramType(carte: LoyaltyCarteLike): LoyaltyProgramType {
  return carte.type === 'points' ? 'points' : 'tampons';
}

export function getProgramThreshold(carte: LoyaltyCarteLike): number {
  const type = getProgramType(carte);
  const rawThreshold = type === 'points' ? carte.points_recompense : carte.tampons_total;
  return Math.max(1, asPositiveInteger(rawThreshold, type === 'points' ? 100 : 10));
}

export function getActiveScore(carte: LoyaltyCarteLike, client: LoyaltyClientLike): number {
  return getProgramType(carte) === 'points'
    ? asPositiveInteger(client.points_actuels)
    : asPositiveInteger(client.tampons_actuels);
}

function normalizeLegacyScore(carte: LoyaltyCarteLike, client: LoyaltyClientLike): number {
  const score = getActiveScore(carte, client);
  const threshold = getProgramThreshold(carte);
  const rewards = asPositiveInteger(client.recompenses_obtenues);

  // Ancien comportement: le score restait bloque au seuil apres obtention d'une recompense.
  // On normalise pour ne pas recompter cette recompense au prochain scan.
  if (rewards > 0 && score >= threshold) return score % threshold;
  return score;
}

export function applyProgressIncrement(
  carte: LoyaltyCarteLike,
  client: LoyaltyClientLike,
  amount: number,
): LoyaltyProgressResult {
  const type = getProgramType(carte);
  const threshold = getProgramThreshold(carte);
  const activeScoreBefore = normalizeLegacyScore(carte, client);
  const totalScore = activeScoreBefore + asPositiveInteger(amount);
  const rewardsEarned = Math.floor(totalScore / threshold);
  const activeScoreAfter = totalScore % threshold;

  const basePoints = asPositiveInteger(client.points_actuels);
  const baseTampons = asPositiveInteger(client.tampons_actuels);

  return {
    newPoints: type === 'points' ? activeScoreAfter : basePoints,
    newTampons: type === 'tampons' ? activeScoreAfter : baseTampons,
    recompensesObtenues: asPositiveInteger(client.recompenses_obtenues) + rewardsEarned,
    activeScoreBefore,
    activeScoreAfter,
    rewardsEarned,
  };
}

export function applyRewardRedemption(
  carte: LoyaltyCarteLike,
  client: LoyaltyClientLike,
  quantity: number,
): LoyaltyProgressResult {
  const type = getProgramType(carte);
  const activeScoreBefore = normalizeLegacyScore(carte, client);
  const basePoints = asPositiveInteger(client.points_actuels);
  const baseTampons = asPositiveInteger(client.tampons_actuels);
  const rewardsBefore = asPositiveInteger(client.recompenses_obtenues);
  const rewardsUsed = Math.min(rewardsBefore, Math.max(1, asPositiveInteger(quantity, 1)));

  return {
    newPoints: type === 'points' ? activeScoreBefore : basePoints,
    newTampons: type === 'tampons' ? activeScoreBefore : baseTampons,
    recompensesObtenues: Math.max(0, rewardsBefore - rewardsUsed),
    activeScoreBefore,
    activeScoreAfter: activeScoreBefore,
    rewardsEarned: 0,
  };
}

export function applyScoreReset(
  carte: LoyaltyCarteLike,
  client: LoyaltyClientLike,
): LoyaltyProgressResult {
  const type = getProgramType(carte);
  const activeScoreBefore = getActiveScore(carte, client);
  const basePoints = asPositiveInteger(client.points_actuels);
  const baseTampons = asPositiveInteger(client.tampons_actuels);

  return {
    newPoints: type === 'points' ? 0 : basePoints,
    newTampons: type === 'tampons' ? 0 : baseTampons,
    recompensesObtenues: asPositiveInteger(client.recompenses_obtenues),
    activeScoreBefore,
    activeScoreAfter: 0,
    rewardsEarned: 0,
  };
}
