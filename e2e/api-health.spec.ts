import { expect, test } from '@playwright/test';

const explicitApiUrl = process.env.E2E_API_URL?.trim() || 'https://api.fidelopass.com';

test('API health répond ok', async ({ request }) => {
  const res = await request.get(`${explicitApiUrl.replace(/\/$/, '')}/api/health`);
  expect(res.ok()).toBeTruthy();
  const payload = await res.json();
  expect(payload?.ok).toBe(true);
});

