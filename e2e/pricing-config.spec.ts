import { expect, test } from '@playwright/test';

const apiBaseUrl = process.env.E2E_API_URL?.trim() || 'https://api.fidelopass.com';
const accessToken = process.env.E2E_ACCESS_TOKEN?.trim() || '';

type PricingEntry = {
  slot: string;
  mode: 'subscription' | 'payment';
  priceId: string | null;
  available: boolean;
};

test.describe('Pricing config utilisable', () => {
  test('retourne une config cohérente pour starter et pro', async ({ request }) => {
    test.skip(!accessToken, 'Définir E2E_ACCESS_TOKEN pour valider /api/checkout/pricing-config.');

    const response = await request.get(`${apiBaseUrl}/api/checkout/pricing-config`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    expect(response.ok()).toBeTruthy();

    const payload = await response.json();
    const starter = payload?.data?.starter;
    const pro = payload?.data?.pro;
    expect(starter).toBeTruthy();
    expect(pro).toBeTruthy();

    const requiredEntries: PricingEntry[] = [
      starter.monthly,
      starter.annual_monthly,
      starter.annual_once,
      pro.monthly,
      pro.annual_monthly,
      pro.annual_once,
    ];

    requiredEntries.forEach((entry) => {
      expect(typeof entry?.slot).toBe('string');
      expect(entry?.mode === 'subscription' || entry?.mode === 'payment').toBeTruthy();
      expect(typeof entry?.available).toBe('boolean');
      if (entry?.available) {
        expect(typeof entry?.priceId).toBe('string');
        expect(String(entry?.priceId ?? '').length).toBeGreaterThan(4);
      }
    });

    const starterHasAtLeastOnePrice = [starter.monthly, starter.annual_monthly, starter.annual_once]
      .some((entry: PricingEntry) => entry.available && Boolean(entry.priceId));
    const proHasAtLeastOnePrice = [pro.monthly, pro.annual_monthly, pro.annual_once]
      .some((entry: PricingEntry) => entry.available && Boolean(entry.priceId));

    expect(starterHasAtLeastOnePrice).toBeTruthy();
    expect(proHasAtLeastOnePrice).toBeTruthy();
  });
});
