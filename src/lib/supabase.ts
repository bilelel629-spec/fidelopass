import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

// PUBLIC_ = accessible navigateur + serveur Astro
// Sans préfixe = serveur uniquement (API Hono / Node.js)
const supabaseUrl =
  (typeof import.meta !== 'undefined' && (import.meta.env?.PUBLIC_SUPABASE_URL || import.meta.env?.SUPABASE_URL))
  ?? process.env.PUBLIC_SUPABASE_URL
  ?? process.env.SUPABASE_URL
  ?? '';

const supabaseAnonKey =
  (typeof import.meta !== 'undefined' && (import.meta.env?.PUBLIC_SUPABASE_ANON_KEY || import.meta.env?.SUPABASE_ANON_KEY))
  ?? process.env.PUBLIC_SUPABASE_ANON_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase env vars manquantes — vérifiez votre .env');
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);

/** Client avec la service role key — côté serveur/API uniquement */
export function createServiceClient() {
  const serviceKey =
    (typeof import.meta !== 'undefined' && import.meta.env?.SUPABASE_SERVICE_ROLE_KEY)
    ?? process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? '';
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY est requis');
  return createClient<Database>(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
