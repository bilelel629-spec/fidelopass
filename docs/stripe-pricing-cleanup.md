# Nettoyage Stripe des tarifs FideloPass

Dernière vérification: 2026-06-01.

## Grille canonique

Ces Price IDs live sont ceux utilisés par l'application en production via `stripe-price-ids.json`.

| Offre | Prix | Price ID live |
| --- | ---: | --- |
| Starter mensuel | 29 EUR / mois | `price_1TdQrU60FYcAjVxlBjtioXnr` |
| Starter annuel récurrent | 295 EUR / an | `price_1TdTej60FYcAjVxlkBzMrWwQ` |
| Pro mensuel | 69 EUR / mois | `price_1TdQrW60FYcAjVxlVJcylHrc` |
| Pro annuel récurrent | 699 EUR / an | `price_1TdTek60FYcAjVxl6chYaXlD` |
| Business mensuel | 199 EUR / mois | `price_1TdQsf60FYcAjVxlPxRw7uBB` |
| Business annuel récurrent | 1990 EUR / an | `price_1TdTel60FYcAjVxlN56tBeCL` |
| Accompagnement Setup | 90 EUR une fois | `price_1TdQrZ60FYcAjVxlQb01ADw1` |

## Prix live à archiver

Dans Stripe, un Price utilisé ne se supprime généralement pas: il faut le passer en inactif. Avant archivage, vérifier qu'il n'est pas utilisé par un abonnement actif.

Dry-run automatique:

```bash
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-cleanup-prices.js
```

Archivage réel, hors packs SMS:

```bash
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-cleanup-prices.js --apply
```

Archivage réel en incluant aussi les packs SMS:

```bash
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-cleanup-prices.js --apply --include-sms
```

Le script bloque automatiquement l'archivage d'un Price s'il détecte un abonnement actif, trial, past_due ou incomplete dessus.

### Starter Indépendant

- `price_1TMlW060FYcAjVxlpG5nCtKf` - 29 EUR / mois, doublon historique.
- `price_1TMlW060FYcAjVxlhdUZ62Fn` - 290 EUR / an, ancien annuel.
- `price_1TMlVz60FYcAjVxlSG7wb8dA` - 300 EUR / an, ancien annuel.
- `price_1TMlVz60FYcAjVxl8VNyc7o6` - 35 EUR / mois, ancien mensuel.
- `price_1TMlVy60FYcAjVxlsTpI09J1` - 25 EUR / mois avec engagement annuel, ancienne offre retirée.
- `price_1TdQrV60FYcAjVxlVDXjt4PY` - 295 EUR paiement unique annuel, remplacé par un abonnement annuel récurrent.

### Commerce Pro

- `price_1TMlVy60FYcAjVxlfcAuf9EZ` - 59 EUR / mois, ancien mensuel.
- `price_1TMlVy60FYcAjVxlNO6cYh4J` - 590 EUR / an, ancien annuel.
- `price_1TMlVx60FYcAjVxlm2p12mJm` - 65 EUR / mois, ancien mensuel.
- `price_1TMlVx60FYcAjVxlTlIYvWFd` - 588 EUR / an, ancien annuel.
- `price_1TMlVw60FYcAjVxlVWNs7aJd` - 49 EUR / mois avec engagement annuel, ancienne offre retirée.
- `price_1TdQrY60FYcAjVxlFIxW5eRJ` - 699 EUR paiement unique annuel, remplacé par un abonnement annuel récurrent.

### Business

- `price_1TdQsh60FYcAjVxlm2MTX3tg` - 1990 EUR paiement unique annuel, remplacé par un abonnement annuel récurrent.

### Scanner supplémentaire

- `price_1TMlVy60FYcAjVxl06t2Sgq1` - 5 EUR, à archiver car les scanners sont désormais illimités sur tous les plans.
- Le produit `Scanner supplémentaire` peut aussi être archivé s'il ne contient plus aucun prix utile.

### Accompagnement Setup

- `price_1TMlVu60FYcAjVxl8HONXsoV` - 20 EUR, à archiver s'il apparaît encore actif.

### Pack SMS

À garder uniquement si les packs SMS restent vendus. Sinon archiver:

- `price_1TMlVy60FYcAjVxln9HC0DaE` - 12 EUR.
- `price_1TMlVy60FYcAjVxlRDOgzQWc` - 49 EUR.
- `price_1TMlVy60FYcAjVxlD5phFUTz` - 159 EUR.

## Séparation test / live

- Production/live: `stripe-price-ids.json`.
- Test: `stripe-price-ids.test.json`, ignoré par Git.
- Exemple test: `stripe-price-ids.test.example.json`.

L'application choisit automatiquement le fichier selon `STRIPE_SECRET_KEY`:

- `sk_live_...` => `stripe-price-ids.json`.
- `sk_test_...` => `stripe-price-ids.test.json`.

Si une clé test est utilisée sans `stripe-price-ids.test.json`, l'API crée ou réutilise automatiquement des prix test canoniques. Les Price IDs live ne sont jamais envoyés à Stripe test.

## Créer la grille test

```bash
STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js --mode=test
```

Le script crée ou réutilise les produits/prix canoniques et écrit `stripe-price-ids.test.json`.

## Vérifier le portail client Stripe

```bash
STRIPE_SECRET_KEY=sk_live_... node scripts/check-stripe-portal.mjs
STRIPE_SECRET_KEY=sk_test_... node scripts/check-stripe-portal.mjs
```

Le script vérifie que les prix Starter, Pro et Business attendus sont autorisés dans les configurations Billing Portal actives.
