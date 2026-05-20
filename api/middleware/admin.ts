import type { Context, Next } from 'hono';
import type { ApiEnv } from '../types';

const builtInAdminEmails = ['bilelel@live.fr', 'bilelel629@gmail.com', 'bilel@pulse-agency.fr'];

const adminEmails = Array.from(new Set([
  ...builtInAdminEmails,
  ...(process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean),
]));

/** Vérifie que l'utilisateur est super admin (email dans ADMIN_EMAILS) */
export async function adminMiddleware(c: Context<ApiEnv>, next: Next) {
  const user = c.get('user');

  if (!user?.email || !adminEmails.includes(user.email.toLowerCase())) {
    return c.json({ error: 'Accès réservé aux administrateurs' }, 403);
  }

  await next();
}
