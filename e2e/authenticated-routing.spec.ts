import { expect, test } from '@playwright/test';

const email = process.env.E2E_USER_EMAIL?.trim() || '';
const password = process.env.E2E_USER_PASSWORD?.trim() || '';
const includeProtectedFlows = process.env.E2E_INCLUDE_PROTECTED === '1';

test.describe('Routage post-login', () => {
  test('Connexion redirige rapidement vers dashboard/onboarding/abonnement', async ({ page }) => {
    test.skip(
      !includeProtectedFlows || !email || !password,
      'Activer E2E_INCLUDE_PROTECTED=1 + E2E_USER_EMAIL + E2E_USER_PASSWORD pour ce test.',
    );

    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Mot de passe').fill(password);
    await page.getByRole('button', { name: /se connecter/i }).click();

    await page.waitForURL(/\/(dashboard|onboarding|abonnement\/choix)/, { timeout: 8_000 });
    expect(page.url()).toMatch(/\/(dashboard|onboarding|abonnement\/choix)/);
  });
});
