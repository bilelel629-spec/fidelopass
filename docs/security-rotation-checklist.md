# Sécurité — Rotation des secrets (URGENT)

## Pourquoi
Des clés sensibles ont circulé pendant les échanges. Même si elles ne sont pas dans le repo, elles doivent être considérées compromises.

## Rotation immédiate (ordre recommandé)
1. Stripe
   - Régénérer `STRIPE_SECRET_KEY`.
   - Régénérer `STRIPE_WEBHOOK_SECRET` sur l’endpoint Railway.
2. Supabase
   - Régénérer `SUPABASE_SERVICE_ROLE_KEY`.
   - Régénérer `SUPABASE_ANON_KEY` + `PUBLIC_SUPABASE_ANON_KEY`.
3. Apple Wallet
   - Révoquer/recréer certif + clé signer (`APPLE_SIGNER_CERT_PEM`, `APPLE_SIGNER_KEY_PEM`).
   - Vérifier `APPLE_PASS_TYPE_ID`, `APPLE_TEAM_ID`.
4. Google Wallet / Firebase
   - Régénérer la clé privée du compte service (`GOOGLE_SERVICE_ACCOUNT_JSON`).
   - Régénérer les clés Firebase si besoin.
5. Brevo
   - Régénérer `BREVO_API_KEY`.

## Après rotation
1. Mettre toutes les nouvelles valeurs dans Railway (API + Web selon usage).
2. Redéployer API puis Web.
3. Vérifier:
   - `GET /api/health/deps`
   - envoi notification test Wallet
   - création de session checkout test.

## Contrôles anti-régression
- Le repo inclut maintenant `npm run security:audit`.
- La CI exécute cette vérification à chaque push/PR.

