import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { autocompleteAddress, reverseGeocode } from '../services/geocoding';

export const geocodingRoutes = new Hono();

geocodingRoutes.use('*', authMiddleware);
geocodingRoutes.use('*', paidMiddleware);

geocodingRoutes.get('/autocomplete', async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  const limit = Math.min(Number(c.req.query('limit') ?? 6) || 6, 8);

  if (query.length < 3) {
    return c.json({ data: [] });
  }

  const suggestions = await autocompleteAddress(query, limit);
  return c.json({ data: suggestions });
});

geocodingRoutes.get('/reverse', async (c) => {
  const params = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  }).safeParse({
    lat: c.req.query('lat'),
    lng: c.req.query('lng'),
  });

  if (!params.success) {
    return c.json({ error: 'Coordonnées invalides' }, 400);
  }

  const suggestion = await reverseGeocode(params.data.lat, params.data.lng);
  return c.json({ data: suggestion });
});
