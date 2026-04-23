import type { Context, Next } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { getCookie } from 'hono/cookie';

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const authTimeoutMs = Number(process.env.AUTH_PROVIDER_TIMEOUT_MS ?? 2500);

const supabaseAuthClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type SupabaseAuthResult = Awaited<ReturnType<typeof supabaseAuthClient.auth.getUser>>;

async function getUserWithTimeout(token: string): Promise<SupabaseAuthResult | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), authTimeoutMs);
  });

  const userPromise = supabaseAuthClient.auth.getUser(token);
  const result = await Promise.race([userPromise, timeoutPromise]);

  if (timer) clearTimeout(timer);
  return result;
}

/** Vérifie le JWT Supabase et injecte l'utilisateur dans le contexte */
export async function authMiddleware(c: Context, next: Next) {
  const authorization = c.req.header('Authorization');
  const cookieToken = getCookie(c, 'fp_session');

  if (!authorization?.startsWith('Bearer ') && !cookieToken) {
    return c.json({ error: 'Token d\'authentification manquant' }, 401);
  }

  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : cookieToken!;

  const authResult = await getUserWithTimeout(token);
  if (!authResult) {
    return c.json({ error: 'Service d’authentification momentanément indisponible' }, 503);
  }

  const { data: { user }, error } = authResult;

  if (error || !user) {
    return c.json({ error: 'Token invalide ou expiré' }, 401);
  }

  c.set('user', user);
  c.set('userId', user.id);
  await next();
}
