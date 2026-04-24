# Runbook Ops — Fidelopass (prod)

## Objectif
Réduire le temps de diagnostic quand un incident touche les flux critiques commerce:
- checkout / abonnement,
- notifications wallet,
- scanner caisse.

## Vérifications de base (toujours en premier)
1. `GET /api/health` doit répondre `ok: true`.
2. `GET /api/health/deps`:
   - `services.database.ok` = `true`
   - `services.stripe.ok` = `true`
   - `services.wallet.apple_ok` ou `services.wallet.google_ok` selon le cas incident.
3. Vérifier les variables Railway:
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - `APPLE_SIGNER_CERT_PEM`, `APPLE_SIGNER_KEY_PEM`, `APPLE_PASS_TYPE_ID`, `APPLE_TEAM_ID`
   - `GOOGLE_ISSUER_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`
4. Contrôler la latence:
   - logs `Slow API` au-dessus du seuil `SLOW_REQUEST_THRESHOLD_MS`.

---

## Incident checkout / abonnement
### Symptômes
- CTA abonnement désactivés,
- erreur `No such price`,
- redirection Stripe absente.

### Diagnostic rapide
1. Appeler `GET /api/checkout/pricing-config` (avec token user non abonné):
   - vérifier `data.starter.*.priceId` et `data.pro.*.priceId`
   - vérifier `available=true` sur au moins un slot Starter et un slot Pro.
2. Vérifier `stripe-price-ids.json` dans le repo.
3. Vérifier côté Stripe que les `price_...` existent et sont actifs.
4. Vérifier webhook Stripe:
   - route `/api/stripe-webhook`
   - endpoint secret cohérent.

### Correctif
1. Mettre à jour `stripe-price-ids.json`.
2. Redéployer API + web.
3. Revalider `pricing-config` puis test d’achat de bout en bout.

---

## Incident notifications wallet
### Symptômes
- pas de notification après envoi,
- compteur envoi ne progresse pas,
- Apple/Google non mis à jour.

### Diagnostic rapide
1. Vérifier `POST /api/notifications/send` (ou action dashboard) retourne 200.
2. Vérifier la carte ciblée:
   - `point_vente_id` correct,
   - canaux wallet présents.
3. Vérifier certificats Apple et compte service Google.
4. Vérifier `services.wallet` dans `/api/health/deps`.

### Correctif
1. Régénérer/mettre à jour secrets wallet.
2. Rejouer un envoi test depuis un point de vente isolé.
3. Vérifier sur appareil réel (iOS + Android) avec carte fraîchement installée.

---

## Incident scanner caisse
### Symptômes
- scanner lent au démarrage,
- token scanner rejeté,
- scan QR sans action.

### Diagnostic rapide
1. Vérifier page `/app/install`:
   - token présent dans l’URL,
   - `GET /api/scanners/status` OK.
2. Vérifier enregistrement scanner:
   - `POST /api/scanners/register` OK.
3. Vérifier transaction scan:
   - `POST /api/transactions` OK,
   - point de vente actif cohérent.
4. Vérifier protection navigateur mobile (caméra autorisée).

### Correctif
1. Régénérer le scanner token depuis dashboard.
2. Réinstaller le scanner sur l’écran d’accueil.
3. Tester scan avec carte publique récente.

---

## Post-mortem minimal (après incident)
1. Résumé incident (impact + durée).
2. Cause racine.
3. Correctif immédiat appliqué.
4. Action préventive:
   - test e2e ajouté / ajusté,
   - alerte observabilité,
   - doc runbook mise à jour.
