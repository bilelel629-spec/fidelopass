import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { randomUUID } from 'crypto';

export const uploadRoutes = new Hono();

const BUCKET = 'cartes';

async function ensureBucket(db: ReturnType<typeof createServiceClient>) {
  const { data: buckets } = await db.storage.listBuckets();
  const exists = buckets?.some(b => b.name === BUCKET);
  if (!exists) {
    await db.storage.createBucket(BUCKET, { public: true, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], fileSizeLimit: 5 * 1024 * 1024 });
  }
}

/** POST /api/upload — Upload d'une image vers Supabase Storage */
uploadRoutes.post('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;

  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || typeof file === 'string') {
    return c.json({ error: 'Fichier manquant' }, 400);
  }

  const fileObj = file as File;
  const ext = fileObj.name.split('.').pop()?.toLowerCase() ?? 'png';
  const allowed = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

  if (!allowed.includes(ext)) {
    return c.json({ error: 'Format non supporté (PNG, JPG, WEBP, GIF)' }, 400);
  }

  if (fileObj.size > 5 * 1024 * 1024) {
    return c.json({ error: 'Fichier trop lourd (max 5 Mo)' }, 400);
  }

  const db = createServiceClient();

  // Crée le bucket s'il n'existe pas encore
  await ensureBucket(db);

  const filename = `${userId}/${randomUUID()}.${ext}`;
  const buffer = Buffer.from(await fileObj.arrayBuffer());

  const { data, error } = await db.storage
    .from(BUCKET)
    .upload(filename, buffer, { contentType: fileObj.type, upsert: true });

  if (error) {
    console.error('[Upload]', error);
    return c.json({ error: `Erreur upload : ${error.message}` }, 500);
  }

  const { data: { publicUrl } } = db.storage.from(BUCKET).getPublicUrl(data.path);

  return c.json({ url: publicUrl });
});
