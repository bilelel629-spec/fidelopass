# Vente en Suisse et facturation CHF

## Principe

- Les abonnements EUR existants restent attachés à leurs Price IDs actuels.
- Les nouveaux clients suisses utilisent des Price IDs CHF distincts.
- Le navigateur transmet uniquement le plan, la périodicité et la devise.
- Le serveur choisit le Price ID Stripe.
- Une devise est verrouillée après confirmation Stripe d'un premier paiement ou abonnement.
- Un changement de plan reste obligatoirement dans la devise Stripe courante.

## Ordre de mise en production

1. Appliquer `supabase/migrations/035_multicurrency_billing.sql`.
2. Créer et vérifier les prix CHF en mode test.
3. Ajouter les variables CHF dans l'environnement Railway de test.
4. Tester checkout, webhooks, changement de plan, annulation et réactivation.
5. Créer les prix CHF live.
6. Ajouter les variables CHF dans Railway production.
7. Déployer l'application.
8. Tester une souscription CHF réelle puis la rembourser si nécessaire.

La migration ne recrée aucun abonnement. Les commerces possédant déjà un
`stripe_subscription_id` sont conservés en EUR et leur devise est verrouillée.

## Création des prix Stripe

Mode test :

```bash
STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js --mode=test --currency=chf
```

Mode live :

```bash
STRIPE_SECRET_KEY=sk_live_... node scripts/setup-stripe.js --mode=live --currency=chf
```

Le script réutilise les produits Fidelopass et crée des Prices CHF distincts.
Il affiche les variables Railway à copier.

## Variables Railway

```text
STRIPE_PRICE_ID_CHF_STARTER_MENSUEL
STRIPE_PRICE_ID_CHF_STARTER_ANNUEL_ONCE
STRIPE_PRICE_ID_CHF_PRO_MENSUEL
STRIPE_PRICE_ID_CHF_PRO_ANNUEL_ONCE
STRIPE_PRICE_ID_CHF_BUSINESS_MENSUEL
STRIPE_PRICE_ID_CHF_BUSINESS_ANNUEL_ONCE
STRIPE_PRICE_ID_CHF_ACCOMPAGNEMENT
```

Ne pas renommer ni supprimer les variables ou Price IDs EUR existants.

## Code promotionnel SETUP10

- Une promotion en pourcentage peut être autorisée pour les paiements EUR et CHF.
- Une promotion avec montant fixe doit utiliser un coupon CHF distinct.
- Vérifier dans Stripe que le code est actif jusqu'au 1er juillet et qu'il
  s'applique aux produits souhaités.

## Fiscalité

Le checkout conserve actuellement `automatic_tax: false`. Avant une
commercialisation large en Suisse, faire valider les règles de TVA, les mentions
de facture et le caractère HT/TTC des prix par le conseil comptable de
Fidelopass.

## Tests manuels

- Ancien abonnement EUR : renouvellement et portail inchangés.
- Nouveau client France : affichage et checkout EUR.
- Nouveau client Suisse : affichage et checkout CHF.
- Choix manuel EUR/CHF mémorisé après inscription.
- Starter CHF mensuel, Pro CHF annuel et accompagnement CHF.
- Refus d'une devise différente sur un compte déjà verrouillé.
- Upgrade et downgrade dans la devise existante.
- Paiement réussi, paiement échoué et annulation reçus par webhook.
- Facture et email de paiement affichés dans la devise Stripe réelle.
