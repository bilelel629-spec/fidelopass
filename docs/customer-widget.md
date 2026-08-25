# Widget espace fidélité

Le composant `<fidelopass-loyalty>` permet à un commerçant d'afficher l'espace
fidélité de ses clients directement sur son propre site. Le client utilise le
numéro déjà associé à sa carte et reçoit un code SMS à six chiffres : aucun mot
de passe supplémentaire n'est créé.

## Installation commerçant

1. Ouvrir **Mon compte → Espace fidélité** dans Fidelopass.
2. Ajouter les origines HTTPS autorisées, par exemple
   `https://www.maboutique.fr` et `https://maboutique.fr`.
3. Renseigner l'URL de la page fidélité du site commerçant.
4. Personnaliser le titre, la couleur et, si nécessaire, le logo.
5. Activer puis enregistrer le widget.
6. Copier le code d'intégration avant `</body>` sur le site commerçant.

Le code produit ressemble à ceci :

```html
<script src="https://www.fidelopass.com/widget/v1/client.js" defer></script>
<fidelopass-loyalty
  program="wgt_cle_publique_du_programme"
  api-url="https://api.fidelopass.com">
</fidelopass-loyalty>
```

Le mode par défaut affiche un bouton flottant. Pour intégrer le panneau dans la
mise en page, ajouter `mode="inline"` sur l'élément.

## Parcours client

1. Le client saisit le téléphone utilisé lors de la création de sa carte.
2. L'API répond toujours avec le même message afin de ne pas révéler si le
   numéro existe.
3. Si une carte active correspond, Brevo envoie un OTP valable dix minutes.
4. Après vérification, un jeton opaque limité au commerce reste valide trente
   jours.
5. Le widget affiche uniquement les données fidélité nécessaires : prénom,
   solde, catalogue et disponibilité des récompenses, historique récent et
   boutons Wallet.

## Sécurité et exploitation

- Les domaines sont vérifiés côté serveur sur chaque requête publique.
- Les OTP et jetons de session sont stockés sous forme de HMAC, jamais en clair.
- Les tentatives sont limitées par numéro et par adresse IP.
- Un OTP expire après dix minutes, est bloqué après cinq essais et ne peut être
  consommé qu'une fois.
- Les tables d'authentification ont RLS actif et sont exclusivement accessibles
  au rôle serveur.
- Le widget est en lecture seule : une récompense doit toujours être validée par
  le commerçant ou son scanner.
- Les cartes Wallet ne contiennent pas de session. Leur lien ouvre simplement la
  page fidélité du commerçant, où le client s'authentifie.

Variables serveur requises :

```dotenv
CUSTOMER_WIDGET_ENABLED=true
WIDGET_AUTH_SECRET=secret-aleatoire-de-32-caracteres-minimum
WIDGET_SMS_SENDER=FideloPass
BREVO_API_KEY=...
```

`TURNSTILE_SECRET_KEY` peut être ajouté pour activer la vérification Cloudflare
Turnstile côté API lorsqu'un jeton est transmis par l'intégration.
