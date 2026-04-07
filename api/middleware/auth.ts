import type { Context, Next } from 'hono';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** Vérifie le JWT Supabase et injecte l'utilisateur dans le contexte */
export async function authMiddleware(c: Context, next: Next) {
  const authorization = c.req.header('Authorization');

  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'Token d\'authentification manquant' }, 401);
  }

  const token = authorization.slice(7);

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return c.json({ error: 'Token invalide ou expiré' }, 401);
  }

  c.set('user', user);
  c.set('userId', user.id);
  await next();
}
