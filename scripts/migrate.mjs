/**
 * Exécute la migration SQL via la connexion directe Supabase (Transaction Pooler)
 * Usage : node scripts/migrate.mjs
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis dans .env');
  process.exit(1);
}

// On utilise l'API Supabase pour créer les tables via rpc exec_sql
// D'abord on crée la fonction helper si elle n'existe pas
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Découpe le SQL en statements individuels et les exécute via fetch direct
const sqlFile = resolve(process.cwd(), 'supabase/migrations/001_init.sql');
const sql = readFileSync(sqlFile, 'utf-8');

// Utilise l'API Management de Supabase pour exécuter du SQL arbitraire
// via l'endpoint SQL (dispo sur les projets récents)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];

async function runSQL(statement) {
  const statement_trimmed = statement.trim();
  if (!statement_trimmed || statement_trimmed.startsWith('--')) return null;

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ query: statement_trimmed }),
    }
  );

  return { status: res.status, body: await res.text() };
}

// Teste si l'API management est accessible
const testRes = await runSQL('SELECT 1');
console.log('Test API:', testRes?.status, testRes?.body?.slice(0, 100));

if (testRes?.status !== 200) {
  console.log('\n⚠️  L\'API Management Supabase nécessite un token personnel.');
  console.log('Utilise la méthode alternative (fetch SQL direct)...\n');

  // Méthode alternative : exécution via endpoint Postgrest avec service key
  // Supabase expose un endpoint SQL sur certains plans
  const sqlRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ sql }),
  });
  console.log('RPC exec_sql:', sqlRes.status, (await sqlRes.text()).slice(0, 200));
}
