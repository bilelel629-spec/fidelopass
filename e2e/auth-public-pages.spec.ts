import { expect, test } from '@playwright/test';

test.describe('Pages auth publiques', () => {
  test('Login reste stable sans session (pas de redirection tardive)', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
    await expect(page.getByRole('heading', { name: /bienvenue/i })).toBeVisible();

    await page.waitForTimeout(3_000);
    await expect(page).toHaveURL(/\/login(?:[?#].*)?$/);
  });

  test('Register reste stable sans session (pas de redirection tardive)', async ({ page }) => {
    await page.goto('/register', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/register(?:[?#].*)?$/);
    await expect(page.getByRole('heading', { name: /créer mon compte/i })).toBeVisible();

    await page.waitForTimeout(3_000);
    await expect(page).toHaveURL(/\/register(?:[?#].*)?$/);
  });

  test('Abonnement choix redirige rapidement vers register sans session', async ({ page }) => {
    const startedAt = Date.now();
    await page.goto('/abonnement/choix', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/register(?:[?#].*)?$/, { timeout: 4_000 });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(4_000);
  });

  test('Abonnement setup redirige rapidement vers register sans session', async ({ page }) => {
    const startedAt = Date.now();
    await page.goto('/abonnement/setup', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/register(?:[?#].*)?$/, { timeout: 5_000 });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(5_000);
  });
});
