import { createClient } from '@supabase/supabase-js';

const processEnv = typeof process !== 'undefined' ? process.env : {};

// PUBLIC_ = accessible navigateur + serveur Astro
// Sans préfixe = serveur uniquement (API Hono / Node.js)
const supabaseUrl =
  (typeof import.meta !== 'undefined' ? (import.meta.env?.PUBLIC_SUPABASE_URL || import.meta.env?.SUPABASE_URL) : undefined)
  ?? processEnv.PUBLIC_SUPABASE_URL
  ?? processEnv.SUPABASE_URL
  ?? '';

const supabaseAnonKey =
  (typeof import.meta !== 'undefined' ? (import.meta.env?.PUBLIC_SUPABASE_ANON_KEY || import.meta.env?.SUPABASE_ANON_KEY) : undefined)
  ?? processEnv.PUBLIC_SUPABASE_ANON_KEY
  ?? processEnv.SUPABASE_ANON_KEY
  ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase env vars manquantes — vérifiez votre .env');
}

export const supabase = createClient(
  supabaseUrl || 'http://localhost:54321',
  supabaseAnonKey || 'missing-anon-key',
);

/** Client avec la service role key — côté serveur/API uniquement */
export function createServiceClient() {
  const serviceKey =
    (typeof import.meta !== 'undefined' ? import.meta.env?.SUPABASE_SERVICE_ROLE_KEY : undefined)
    ?? processEnv.SUPABASE_SERVICE_ROLE_KEY
    ?? '';
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY est requis');
  return createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
