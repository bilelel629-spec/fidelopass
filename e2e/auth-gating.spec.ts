import { expect, test } from '@playwright/test';

const includeProtectedFlows = process.env.E2E_INCLUDE_PROTECTED === '1';

test.describe('Garde accès non authentifié', () => {
  test('Dashboard redirige vers login', async ({ page }) => {
    test.skip(!includeProtectedFlows, 'Activer E2E_INCLUDE_PROTECTED=1 pour tester les pages protégées.');
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login/, { timeout: 12_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('Onboarding redirige vers login', async ({ page }) => {
    test.skip(!includeProtectedFlows, 'Activer E2E_INCLUDE_PROTECTED=1 pour tester les pages protégées.');
    await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login/, { timeout: 12_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('Scanner redirige vers login', async ({ page }) => {
    test.skip(!includeProtectedFlows, 'Activer E2E_INCLUDE_PROTECTED=1 pour tester les pages protégées.');
    await page.goto('/app/scan', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login/, { timeout: 12_000 });
    await expect(page).toHaveURL(/\/login/);
  });
});
