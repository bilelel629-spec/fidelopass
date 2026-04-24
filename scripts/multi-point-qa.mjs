#!/usr/bin/env node

const API_BASE = (process.env.E2E_API_URL || 'https://api.fidelopass.com').replace(/\/$/, '');
const ACCESS_TOKEN = process.env.E2E_ACCESS_TOKEN || '';

if (!ACCESS_TOKEN) {
  console.error('❌ E2E_ACCESS_TOKEN manquant.');
  console.error('Exemple: E2E_ACCESS_TOKEN=... node scripts/multi-point-qa.mjs');
  process.exit(1);
}

async function apiFetch(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function endpointWithPoint(path, pointId) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}point_vente_id=${encodeURIComponent(pointId)}`;
}

async function run() {
  const pointsRes = await apiFetch('/api/commerces/points-vente');
  if (!pointsRes.response.ok) {
    console.error('❌ /api/commerces/points-vente KO', pointsRes.response.status, pointsRes.payload);
    process.exit(1);
  }

  const points = Array.isArray(pointsRes.payload?.data) ? pointsRes.payload.data : [];
  if (!points.length) {
    console.log('ℹ️ Aucun point de vente à tester.');
    process.exit(0);
  }

  const checks = [
    { key: 'summary', path: '/api/notifications/summary' },
    { key: 'review', path: '/api/notifications/review-reminder-settings' },
    { key: 'birthday', path: '/api/notifications/birthday-settings' },
    { key: 'active-card', path: '/api/cartes/active' },
  ];

  const rows = [];
  for (const point of points) {
    const pointId = String(point.id);
    const pointName = String(point.nom ?? point.id);
    for (const check of checks) {
      const result = await apiFetch(endpointWithPoint(check.path, pointId));
      const ok = result.response.ok;
      rows.push({
        point: pointName,
        check: check.key,
        status: ok ? 'OK' : 'FAIL',
        http: result.response.status,
        detail: ok
          ? (
            check.key === 'review'
              ? `plan=${result.payload?.data?.plan ?? 'n/a'}`
              : check.key === 'birthday'
                ? `plan=${result.payload?.data?.plan ?? 'n/a'};active=${Boolean(result.payload?.data?.has_active_card)}`
                : 'ok'
          )
          : (result.payload?.error ?? 'Erreur'),
      });
    }
  }

  console.table(rows);
  const failed = rows.filter((row) => row.status === 'FAIL');
  if (failed.length) {
    console.error(`❌ QA multi-point KO: ${failed.length} vérification(s) en erreur.`);
    process.exit(1);
  }
  console.log('✅ QA multi-point OK.');
}

run().catch((error) => {
  console.error('❌ Erreur QA multi-point', error);
  process.exit(1);
});

