import { Hono } from 'hono';
import type { ApiEnv } from '../types';
import { createServiceClient } from '../../src/lib/supabase';
import { authMiddleware } from '../middleware/auth';
import { paidMiddleware } from '../middleware/paid';
import { rateLimit } from '../middleware/rate-limit';
import { randomUUID } from 'crypto';

export const uploadRoutes = new Hono<ApiEnv>();

const BUCKET = 'cartes';

const MAGIC_MIME_MAP: Array<{ mime: string; check: (b: Buffer) => boolean }> = [
  { mime: 'image/png', check: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { mime: 'image/jpeg', check: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { mime: 'image/gif', check: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { mime: 'image/webp', check: (b) => b.length >= 12 && b.subarray(0, 4).toString('binary') === 'RIFF' && b.subarray(8, 12).toString('binary') === 'WEBP' },
];

function detectMimeFromBytes(buf: Buffer): string | null {
  return MAGIC_MIME_MAP.find((entry) => entry.check(buf))?.mime ?? null;
}

async function ensureBucket(db: ReturnType<typeof createServiceClient>) {
  const { data: buckets } = await db.storage.listBuckets();
  const exists = buckets?.some(b => b.name === BUCKET);
  if (!exists) {
    await db.storage.createBucket(BUCKET, { public: true, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], fileSizeLimit: 5 * 1024 * 1024 });
  }
}

/** POST /api/upload — Upload d'une image vers Supabase Storage */
uploadRoutes.post('/', rateLimit(20, 60_000), authMiddleware, paidMiddleware, async (c) => {
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

  const buffer = Buffer.from(await fileObj.arrayBuffer());

  const detectedMime = detectMimeFromBytes(buffer);
  if (!detectedMime) {
    return c.json({ error: 'Fichier non reconnu. Seuls PNG, JPG, WEBP et GIF sont acceptés.' }, 400);
  }

  const db = createServiceClient();

  // Crée le bucket s'il n'existe pas encore
  await ensureBucket(db);

  const filename = `${userId}/${randomUUID()}.${ext}`;

  const { data, error } = await db.storage
    .from(BUCKET)
    .upload(filename, buffer, { contentType: detectedMime, upsert: true });

  if (error) {
    console.error('[Upload]', error);
    return c.json({ error: `Erreur upload : ${error.message}` }, 500);
  }

  const { data: { publicUrl } } = db.storage.from(BUCKET).getPublicUrl(data.path);

  return c.json({ url: publicUrl });
});
