import { expect, test } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'https://api.fidelopass.com';

test('API health/deps répond avec un statut cohérent', async ({ request }) => {
  const response = await request.get(`${API}/api/health/deps`);
  expect([200, 404, 503]).toContain(response.status());

  if (response.status() === 404) {
    return;
  }

  const payload = await response.json();
  expect(typeof payload?.ok).toBe('boolean');
  expect(typeof payload?.services?.database?.ok).toBe('boolean');
  expect(typeof payload?.services?.stripe?.ok).toBe('boolean');
});
