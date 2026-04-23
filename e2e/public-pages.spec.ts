import { expect, test } from '@playwright/test';

test.describe('Pages publiques critiques', () => {
  test('Homepage charge et affiche les CTA principaux', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: /essai gratuit|démarrer/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /comment ça marche/i }).first()).toBeVisible();
  });

  test('Pricing charge et le CTA renvoie vers le funnel inscription/abonnement', async ({ page }) => {
    await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
    const cta = page.getByRole('link', { name: /démarrer l'essai gratuit/i }).first();
    await expect(cta).toBeVisible();
    const href = await cta.getAttribute('href');
    expect(href ?? '').toMatch(/^\/(register|abonnement\/choix)/);
  });

  test('Comment ça fonctionne charge correctement', async ({ page }) => {
    await page.goto('/comment-ca-fonctionne', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/comment-ca-fonctionne/);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('Contact charge correctement', async ({ page }) => {
    await page.goto('/contact', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/contact/);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
});
