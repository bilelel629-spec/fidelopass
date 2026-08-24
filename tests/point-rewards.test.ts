import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getNewlyAvailablePointRewards,
  getPointRewardState,
  getPointRewardTiers,
  normalizeRewardTiers,
  resolvePointRewardRedemption,
} from '../api/services/point-rewards';
import { applyProgressIncrement } from '../api/services/loyalty-progress';

const multiProgram = {
  type: 'points' as const,
  points_recompense: 100,
  recompense_description: 'Ancienne récompense',
  rewards_multi_enabled: true,
  rewards_config: [
    { seuil: 45, recompense: 'Plat offert' },
    { seuil: 15, recompense: 'Café offert' },
  ],
};

test('normalise, trie et déduplique les paliers', () => {
  assert.deepEqual(normalizeRewardTiers([
    { seuil: 45, recompense: 'Plat offert' },
    { seuil: 15, recompense: 'Café offert' },
    { seuil: 15, recompense: 'Doublon ignoré' },
    { seuil: 0, recompense: 'Invalide' },
    { seuil: 80, recompense: '' },
  ]), [
    { seuil: 15, recompense: 'Café offert' },
    { seuil: 45, recompense: 'Plat offert' },
  ]);
});

test('retombe sur la récompense historique lorsque le mode multiple est désactivé', () => {
  assert.deepEqual(getPointRewardTiers({
    points_recompense: 100,
    recompense_description: '10€ offerts',
    rewards_multi_enabled: false,
    rewards_config: [{ seuil: 15, recompense: 'Café offert' }],
  }), [{ seuil: 100, recompense: '10€ offerts' }]);
});

for (const scenario of [
  { points: 0, available: [], next: 15, missing: 15 },
  { points: 14, available: [], next: 15, missing: 1 },
  { points: 15, available: [15], next: 45, missing: 30 },
  { points: 20, available: [15], next: 45, missing: 25 },
  { points: 44, available: [15], next: 45, missing: 1 },
  { points: 45, available: [15, 45], next: null, missing: null },
  { points: 60, available: [15, 45], next: null, missing: null },
]) {
  test(`calcule le catalogue avec ${scenario.points} points`, () => {
    const state = getPointRewardState(scenario.points, multiProgram);
    assert.deepEqual(state.available_rewards.map((reward) => reward.seuil), scenario.available);
    assert.equal(state.next_reward?.seuil ?? null, scenario.next);
    assert.equal(state.next_reward?.points_manquants ?? null, scenario.missing);
    assert.equal(state.can_use_reward, scenario.available.length > 0);
  });
}

test('utiliser le café avec 20 points laisse 5 points', () => {
  assert.deepEqual(resolvePointRewardRedemption(20, multiProgram, 15), {
    ok: true,
    reward: { seuil: 15, recompense: 'Café offert' },
    points_before: 20,
    points_after: 5,
  });
});

test('utiliser le plat avec 45 points laisse 0 point', () => {
  const result = resolvePointRewardRedemption(45, multiProgram, 45);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.points_after, 0);
});

test('utiliser le café avec 45 points laisse 30 points', () => {
  const result = resolvePointRewardRedemption(45, multiProgram, 15);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.points_after, 30);
});

test('refuse un palier inaccessible', () => {
  assert.deepEqual(resolvePointRewardRedemption(20, multiProgram, 45), {
    ok: false,
    reason: 'INSUFFICIENT_POINTS',
  });
});

test('exige un choix quand plusieurs récompenses sont disponibles', () => {
  assert.deepEqual(resolvePointRewardRedemption(45, multiProgram), {
    ok: false,
    reason: 'REWARD_SELECTION_REQUIRED',
  });
});

test('détecte les paliers nouvellement franchis', () => {
  assert.deepEqual(getNewlyAvailablePointRewards(14, 46, multiProgram), [
    { seuil: 15, recompense: 'Café offert' },
    { seuil: 45, recompense: 'Plat offert' },
  ]);
});

test('conserve les points cumulés en mode récompenses multiples', () => {
  assert.deepEqual(applyProgressIncrement(multiProgram, {
    points_actuels: 0,
    tampons_actuels: 0,
    recompenses_obtenues: 0,
  }, 20), {
    newPoints: 20,
    newTampons: 0,
    recompensesObtenues: 0,
    activeScoreBefore: 0,
    activeScoreAfter: 20,
    rewardsEarned: 0,
  });
});

test('ne remet pas le solde à zéro en franchissant le palier supérieur', () => {
  const progress = applyProgressIncrement(multiProgram, {
    points_actuels: 44,
    tampons_actuels: 0,
    recompenses_obtenues: 0,
  }, 2);
  assert.equal(progress.newPoints, 46);
  assert.equal(progress.recompensesObtenues, 0);
});

test('préserve le comportement historique des points et des tampons', () => {
  const legacyPoints = applyProgressIncrement({
    type: 'points',
    points_recompense: 100,
  }, {
    points_actuels: 90,
    tampons_actuels: 0,
    recompenses_obtenues: 0,
  }, 20);
  assert.equal(legacyPoints.newPoints, 10);
  assert.equal(legacyPoints.recompensesObtenues, 1);

  const stamps = applyProgressIncrement({
    type: 'tampons',
    tampons_total: 10,
  }, {
    points_actuels: 0,
    tampons_actuels: 9,
    recompenses_obtenues: 0,
  }, 2);
  assert.equal(stamps.newTampons, 1);
  assert.equal(stamps.recompensesObtenues, 1);
});
