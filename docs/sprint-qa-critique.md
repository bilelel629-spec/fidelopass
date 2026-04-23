# Sprint 1 — QA critique (Fidelopass)

## Objectif
Valider rapidement les parcours métier les plus sensibles avant chaque release.

## Pré-requis
- `npm install`
- Installation navigateur Playwright:
  - `npm run test:e2e:install`

## Variables utiles
- `E2E_BASE_URL` (défaut: `https://www.fidelopass.com`)
- `E2E_API_URL` (défaut: `https://api.fidelopass.com`)
- `E2E_PUBLIC_CARD_URL` (optionnel, ex: `https://www.fidelopass.com/carte/<id>`)
- `E2E_USER_EMAIL` + `E2E_USER_PASSWORD` (optionnel, active le test de routage post-login)
- `E2E_INCLUDE_PROTECTED=1` (optionnel, active les tests pages protégées `/dashboard`, `/onboarding`, `/app/scan`)

## Commandes
- Lancer toute la suite:
  - `npm run test:e2e`
- Lancer en mode visible:
  - `npm run test:e2e:headed`
- Lancer un fichier précis:
  - `npx playwright test e2e/public-pages.spec.ts`

## Couverture actuelle (critique)
- Pages publiques: home, pricing, comment ça fonctionne, contact.
- Gating accès: `/dashboard`, `/onboarding`, `/app/scan` redirigent vers login sans session.
- Carte publique: pas de chargement infini (si `E2E_PUBLIC_CARD_URL` fourni).
- Santé API: `/api/health`.
- Routage post-login: redirection rapide vers dashboard/onboarding/abonnement (si identifiants fournis).

> Note: en production avec protections anti-bot, les tests “pages protégées” peuvent être bloqués en headless.  
> Dans ce cas, exécuter ces tests sur un environnement contrôlé (staging/local) avec `E2E_INCLUDE_PROTECTED=1`.

## Checklist release
1. `npm run build`
2. `npm run test:e2e`
3. Vérifier que les tests optionnels utiles sont activés via variables d’environnement.
4. Si échec: corriger avant merge/redeploy.
