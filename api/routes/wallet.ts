import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../../src/lib/supabase';
import { generateApplePass } from '../services/apple-wallet';
import { generateGooglePass } from '../services/google-wallet';

export const walletRoutes = new Hono();

const bodySchema = z.object({
  client_id: z.string().uuid(),
});

async function parseClientId(c: Context) {
  if (c.req.method === 'GET') {
    return bodySchema.safeParse({ client_id: c.req.query('client_id') });
  }

  const body = await c.req.json().catch(() => ({}));
  return bodySchema.safeParse(body);
}

async function loadWalletContext(
  carteId: string,
  clientId: string,
  commerceSelect: string,
) {
  const db = createServiceClient();

  const { data: carte } = await db
    .from('cartes')
    .select(`*, commerces(${commerceSelect})`)
    .eq('id', carteId)
    .eq('actif', true)
    .single();

  if (!carte) {
    return { db, carte: null, client: null } as const;
  }

  const { data: client } = await db
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  return { db, carte, client } as const;
}

function isValidApplePassAuth(c: Context, serialNumber: string) {
  const auth = c.req.header('Authorization') ?? '';
  return auth === `ApplePass ${serialNumber}`;
}

async function loadApplePassByClient(serialNumber: string) {
  const db = createServiceClient();
  const { data: client } = await db
    .from('clients')
    .select('*, cartes(*, commerces(id, nom, logo_url, latitude, longitude, rayon_geo))')
    .eq('id', serialNumber)
    .single();

  if (!client?.cartes) return { db, client: null, carte: null } as const;
  const { cartes, ...clientData } = client as typeof client & { cartes: unknown };
  return { db, client: clientData, carte: cartes } as const;
}

walletRoutes.post('/apple/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', async (c) => {
  const serialNumber = c.req.param('serialNumber') ?? '';
  if (!isValidApplePassAuth(c, serialNumber)) return c.body(null, 401);
  const deviceLibraryIdentifier = c.req.param('deviceLibraryIdentifier') ?? '';
  const passTypeIdentifier = c.req.param('passTypeIdentifier') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const pushToken = typeof body.pushToken === 'string' ? body.pushToken : '';
  if (!pushToken) return c.json({ error: 'pushToken manquant' }, 400);

  const db = createServiceClient();
  const { error } = await db
    .from('apple_pass_registrations')
    .upsert({
      client_id: serialNumber,
      device_library_identifier: deviceLibraryIdentifier,
      pass_type_identifier: passTypeIdentifier,
      push_token: pushToken,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'client_id,device_library_identifier,pass_type_identifier' });

  if (error) {
    console.error('[Apple Wallet register]', error);
    return c.json({ error: 'Registration impossible' }, 500);
  }

  return c.body(null, 201);
});

walletRoutes.delete('/apple/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', async (c) => {
  const serialNumber = c.req.param('serialNumber') ?? '';
  if (!isValidApplePassAuth(c, serialNumber)) return c.body(null, 401);
  const deviceLibraryIdentifier = c.req.param('deviceLibraryIdentifier') ?? '';
  const passTypeIdentifier = c.req.param('passTypeIdentifier') ?? '';

  await createServiceClient()
    .from('apple_pass_registrations')
    .delete()
    .eq('client_id', serialNumber)
    .eq('device_library_identifier', deviceLibraryIdentifier)
    .eq('pass_type_identifier', passTypeIdentifier);

  return c.body(null, 200);
});

walletRoutes.get('/apple/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier', async (c) => {
  const deviceLibraryIdentifier = c.req.param('deviceLibraryIdentifier') ?? '';
  const passTypeIdentifier = c.req.param('passTypeIdentifier') ?? '';

  const { data, error } = await createServiceClient()
    .from('apple_pass_registrations')
    .select('client_id')
    .eq('device_library_identifier', deviceLibraryIdentifier)
    .eq('pass_type_identifier', passTypeIdentifier);

  if (error) {
    console.error('[Apple Wallet list registrations]', error);
    return c.json({ error: 'Impossible de lister les passes' }, 500);
  }

  return c.json({
    serialNumbers: (data ?? []).map((row) => row.client_id),
    lastUpdated: new Date().toISOString(),
  });
});

walletRoutes.get('/apple/v1/passes/:passTypeIdentifier/:serialNumber', async (c) => {
  const serialNumber = c.req.param('serialNumber') ?? '';
  if (!isValidApplePassAuth(c, serialNumber)) return c.body(null, 401);

  const { carte, client } = await loadApplePassByClient(serialNumber);
  if (!carte || !client) return c.json({ error: 'Pass introuvable' }, 404);

  try {
    const passBuffer = await generateApplePass(
      carte as Parameters<typeof generateApplePass>[0],
      client as Parameters<typeof generateApplePass>[1],
    );

    return new Response(new Uint8Array(passBuffer), {
      headers: {
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': 'inline; filename="fidelite.pkpass"',
        'Cache-Control': 'no-store',
        'Last-Modified': new Date().toUTCString(),
      },
    });
  } catch (err) {
    console.error('[Apple Wallet update pass]', err);
    return c.json({ error: 'Erreur lors de la génération du pass' }, 500);
  }
});

/** POST /api/wallet/apple/:carteId — Génère un .pkpass Apple Wallet */
const appleWalletHandler = async (c: Context) => {
  const carteId = c.req.param('carteId');
  const parsed = await parseClientId(c);

  if (!parsed.success) {
    return c.json({ error: 'client_id manquant ou invalide' }, 400);
  }

  const { db, carte, client } = await loadWalletContext(
    carteId,
    parsed.data.client_id,
    'id, nom, logo_url, latitude, longitude, rayon_geo',
  );

  if (!carte) return c.json({ error: 'Carte introuvable' }, 404);

  if (!client) return c.json({ error: 'Client introuvable' }, 404);

  try {
    const passBuffer = await generateApplePass(
      carte as Parameters<typeof generateApplePass>[0],
      client,
    );

    await db.from('clients').update({ apple_pass_serial: client.id }).eq('id', client.id);

    return new Response(new Uint8Array(passBuffer), {
      headers: {
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': 'inline; filename="fidelite.pkpass"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[Apple Wallet]', err);
    return c.json({ error: 'Erreur lors de la génération du pass' }, 500);
  }
};

walletRoutes.get('/apple/:carteId', appleWalletHandler);
walletRoutes.post('/apple/:carteId', appleWalletHandler);

/** POST /api/wallet/google/:carteId — Génère l'URL d'ajout Google Wallet */
walletRoutes.post('/google/:carteId', async (c) => {
  const carteId = c.req.param('carteId');
  const parsed = await parseClientId(c);

  if (!parsed.success) {
    return c.json({ error: 'client_id manquant ou invalide' }, 400);
  }

  const { db, carte, client } = await loadWalletContext(
    carteId,
    parsed.data.client_id,
    'id, nom, logo_url',
  );

  if (!carte) return c.json({ error: 'Carte introuvable' }, 404);

  if (!client) return c.json({ error: 'Client introuvable' }, 404);

  try {
    const { objectId, saveUrl } = await generateGooglePass(
      carte as Parameters<typeof generateGooglePass>[0],
      client,
    );
    await db.from('clients').update({ google_pass_id: objectId }).eq('id', client.id);
    return c.json({ saveUrl });
  } catch (err) {
    console.error('[Google Wallet]', err);
    return c.json({ error: 'Erreur lors de la génération du pass' }, 500);
  }
});
