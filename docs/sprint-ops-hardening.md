# Sprints restants — durcissement ops (23/04/2026)

## Objectif
Stabiliser la production Fidelopass sur trois axes:
- vitesse perçue sur les flux auth,
- robustesse API sous charge/intermittence,
- anti-régression via CI.

## Changements livrés

### 1) Auth/API guard plus rapides
- Timeout auth provider introduit côté API middleware:
  - variable: `AUTH_PROVIDER_TIMEOUT_MS` (défaut `2500`)
  - si timeout: réponse `503` explicite plutôt que requête pendante.
- Timeout guard billing dans middleware Astro:
  - variable: `BILLING_GUARD_TIMEOUT_MS` (défaut `1800`)
  - évite les pages protégées qui restent bloquées trop longtemps.
- Timeout billing côté login/register/confirm:
  - variable: `PUBLIC_BILLING_CHECK_TIMEOUT_MS` (défaut `2200`)
  - redirections plus réactives.
- Dédup des redirections auth (`redirectInFlight`) pour empêcher les doubles appels concurrents.

### 2) Observabilité & santé dépendances
- `X-Request-Id` ajouté sur toutes les réponses API.
- Log automatique des requêtes lentes:
  - variable: `SLOW_REQUEST_THRESHOLD_MS` (défaut `1200`).
- Endpoint santé dépendances:
  - `GET /api/health/deps`
  - vérifie DB Supabase + présence clés Stripe/Wallet.
  - retourne `200` si OK, `503` sinon.
- Timeout check DB santé:
  - variable: `HEALTH_DB_TIMEOUT_MS` (défaut `2000`).

### 3) Rate limit mémoire durci
- Prune périodique des entrées expirées.
- Limite de taille de map anti-croissance mémoire:
  - variable: `RATE_LIMIT_MAX_ENTRIES` (défaut `50000`).

### 4) CI de base
- Workflow GitHub Actions ajouté:
  - build systématique sur `push`/`pull_request`.
  - smoke e2e public (job non bloquant, `continue-on-error`).
  - upload du rapport Playwright en artifact.

## Vérification rapide post-deploy
1. `GET /api/health` → `ok: true`
2. `GET /api/health/deps` → `ok: true`
3. Login/Register:
   - pas de latence excessive avant redirection abonnement/dashboard.
4. Dashboard:
   - navigation protégée fluide, pas de blocage long.
