import type { Context, Next } from 'hono';

const builtInAdmins = ['bilelel@live.fr', 'bilelel629@gmail.com'];

const adminEmails = Array.from(new Set([...builtInAdmins, ...(process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean)]));

/** Vérifie que l'utilisateur est super admin (email dans ADMIN_EMAILS) */
export async function adminMiddleware(c: Context, next: Next) {
  const user = c.get('user');

  if (!user?.email || !adminEmails.includes(user.email)) {
    return c.json({ error: 'Accès réservé aux administrateurs' }, 403);
  }

  await next();
}
