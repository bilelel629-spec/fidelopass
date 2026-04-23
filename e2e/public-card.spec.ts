import { expect, test } from '@playwright/test';

const explicitCardUrl = process.env.E2E_PUBLIC_CARD_URL?.trim() || '';

test.describe('Carte publique', () => {
  test('Page carte ne reste pas bloquée sur chargement infini', async ({ page, baseURL }) => {
    const target = explicitCardUrl || '';
    test.skip(!target, 'Définir E2E_PUBLIC_CARD_URL pour activer ce test.');

    const route = target.startsWith('http')
      ? target
      : `${baseURL?.replace(/\/$/, '') ?? ''}${target.startsWith('/') ? target : `/${target}`}`;

    await page.goto(route, { waitUntil: 'domcontentloaded' });

    const loading = page.locator('#loading');
    await expect(loading).toBeVisible();

    const cardContent = page.locator('#carte-content');
    const errorContent = page.locator('#error-content');
    await expect(cardContent.or(errorContent)).toBeVisible({ timeout: 20_000 });
    await expect(loading).toBeHidden({ timeout: 20_000 });

    if (await cardContent.isVisible()) {
      await expect(page.locator('#btn-apple')).toBeVisible();
      await expect(page.locator('#btn-google')).toBeVisible();
    }
  });
});

