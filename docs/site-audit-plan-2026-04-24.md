# Audit complet Fidelopass — 24/04/2026

## Constat global
- Base produit solide et déjà riche (wallet, scan, multi point de vente, onboarding, admin).
- Plusieurs zones critiques restent à industrialiser pour un niveau SaaS premium:
  - stabilité checkout / pricing,
  - dette front (fichiers très volumineux),
  - homogénéité UX (messages d'erreur bloquants),
  - observabilité et logs.

## Points forts observés
- Gating auth + billing déjà présent côté middleware web et API.
- Flows métier coeur (carte, scan, notifications, points de vente) couverts.
- E2E critiques en place (public/auth/health) + build stable.

## Points à améliorer (priorisés)

### P0 — Fiabilité business (revenu, accès, flux caisse)
1. Renforcer le flux pricing/checkout:
   - éviter tout prix Stripe obsolète côté front,
   - désactiver les CTA plans si la config Stripe n'est pas utilisable.
2. Réduire les erreurs bloquantes scanner:
   - remplacer les `alert()` par des retours UX non bloquants.
3. Séparer davantage la logique de `/dashboard/carte` (2k+ lignes) pour diminuer les régressions.

### P1 — UX pro / perception premium
1. Standardiser les retours utilisateur (toasts inline, erreurs contextualisées, pas de popup navigateur).
2. Uniformiser les états de chargement sur toutes les pages dashboard.
3. Finaliser une vraie cohérence de feedback entre mobile scanner et dashboard.

### P1 — Ops / observabilité
1. Limiter les logs verbeux en production (debug flag explicite).
2. Garder les en-têtes de diagnostic (request id / response time) activés.
3. Documenter la checklist de runbook (incident checkout, incident push, incident scan).

### P2 — Maintenabilité
1. Découper `dashboard/carte.astro` en modules UI/state/api.
2. Extraire les helpers répétés (`withTimeout`, `pointAwareFetch`) vers une couche partagée.
3. Étendre les tests e2e aux scénarios paiement + multi-point.

## Plan d'exécution (sprints)

### Sprint A (immédiat, en cours)
- [x] Corriger erreurs TypeScript bloquantes.
- [x] Fiabiliser scripts inline `define:vars`.
- [x] Améliorer scanner (lazy import + await + QR only).
- [x] Ajouter `X-Response-Time` côté middleware web.
- [x] Remplacer les erreurs scanner bloquantes (`alert`) par des toasts.
- [x] Basculer les logs review-campaign sous flag `DEBUG_REVIEW_CAMPAIGN=1`.

### Sprint B (prochain lot)
- [x] Durcir la page `/abonnement/choix` avec validation stricte de la config prix.
- [x] Bloquer visuellement les CTA si un prix requis est indisponible.
- [x] Ajouter test e2e dédié "pricing-config usable".

### Sprint C
- [x] Refactor progressif `/dashboard/carte` (state + preview + save).
- [x] Remplacement complet des derniers `alert()` dashboard.

### Sprint D
- [x] Runbook ops (checkout, push wallet, scanner).
- [x] KPIs de santé consolidés admin.

## Variables utiles
- `DEBUG_REVIEW_CAMPAIGN=1` (logs détaillés campagne avis Google)
- `SLOW_REQUEST_THRESHOLD_MS` (alerte lenteur API)
- `HEALTH_DB_TIMEOUT_MS` (timeout check DB health)
