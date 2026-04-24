# Checklist Ops — Validation production (paiement + multi-point)

## 1) Pré-requis
- Token d’accès commerçant: `E2E_ACCESS_TOKEN`
- API cible: `E2E_API_URL` (ex: `https://api.fidelopass.com`)

## 2) Validation checkout (sans créer de paiement réel)
Commande:

```bash
E2E_API_URL="https://api.fidelopass.com" \
E2E_ACCESS_TOKEN="..." \
npm run ops:checkout-validate
```

Ce script:
- vérifie `/api/checkout/pricing-config`,
- valide tous les slots Starter/Pro disponibles via `dryRun` sur `/api/checkout/create-session`,
- vérifie aussi l’option setup (+20€).

## 3) Validation multi-point de vente
Commande:

```bash
E2E_API_URL="https://api.fidelopass.com" \
E2E_ACCESS_TOKEN="..." \
npm run ops:multi-point-qa
```

Ce script vérifie, pour chaque point de vente:
- résumé notifications,
- réglage avis Google auto,
- réglage anniversaire auto,
- carte active.

## 4) Santé schéma / migrations
Commande:

```bash
curl -s https://api.fidelopass.com/api/health/deps | jq
```

Vérifier:
- `services.migrations.ok = true`
- checks:
  - `birthday_rewards_table.ok`
  - `admin_audit_logs_table.ok`
  - `clients_birth_date_column.ok`
  - `cartes_birthday_column.ok`

