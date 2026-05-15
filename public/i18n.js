(function () {
  const STORAGE_KEY = 'fidelopass.language';
  const SUPPORTED_LANGUAGES = new Set(['fr', 'en']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE', 'SVG']);
  const SKIP_SELECTOR = [
    '[data-fp-i18n-ignore]',
    '[data-no-translate]',
    '.no-translate',
    '.wallet-card',
    '.wallet-preview-card',
    '#wallet-card',
    '#apple-preview',
    '#google-preview',
    '[data-wallet-preview]',
  ].join(', ');

  const entries = [
    ['Accueil', 'Home'],
    ['Comment ça marche', 'How it works'],
    ["Cas d'utilisation", 'Use cases'],
    ['Tarifs', 'Pricing'],
    ['Contact', 'Contact'],
    ['Connexion', 'Log in'],
    ['Se connecter', 'Log in'],
    ['Essai gratuit', 'Free trial'],
    ['Essai gratuit — 14 jours', '14-day free trial'],
    ['Essai gratuit 14 jours', '14-day free trial'],
    ['Démarrer l’essai gratuit', 'Start free trial'],
    ["Démarrer l'essai gratuit", 'Start free trial'],
    ['Aucune carte de crédit', 'No credit card charge today'],
    ['Aucune application pour vos clients', 'No app required for your customers'],
    ['Prêt en 5 minutes', 'Ready in 5 minutes'],
    ['Apple Wallet natif', 'Native Apple Wallet'],
    ['Google Wallet natif', 'Native Google Wallet'],
    ['Transformez vos clients en habitués.', 'Turn your customers into regulars.'],
    ['Créez une carte de fidélité directement dans Apple Wallet et Google Wallet.', 'Create a loyalty card directly in Apple Wallet and Google Wallet.'],
    ["Vos clients l'ajoutent en 20 secondes — sans compte, sans téléchargement.", 'Your customers add it in 20 seconds — no account, no download.'],
    ['Cartes à tampons', 'Stamp cards'],
    ['Carte à tampons', 'Stamp card'],
    ['Carte à points', 'Points card'],
    ['Carte VIP', 'VIP card'],
    ['Carte de membre', 'Membership card'],
    ['Notifications push', 'Push notifications'],
    ['Géolocalisation', 'Geolocation'],
    ['Scanner en caisse', 'Checkout scanner'],
    ['Mode caisse scannette', 'Barcode scanner checkout mode'],
    ['Tout pour fidéliser efficacement', 'Everything you need to build loyalty'],
    ['Prêt à faire revenir vos clients ?', 'Ready to bring customers back?'],
    ['Questions fréquentes', 'Frequently asked questions'],
    ['Produit', 'Product'],
    ['Ressources', 'Resources'],
    ['Guides', 'Guides'],
    ['Démarrage rapide', 'Quick start'],
    ['Devenir revendeur', 'Become a reseller'],
    ['Accès', 'Access'],
    ['Aucune application requise pour vos clients', 'No app required for your customers'],
    ['Tous droits réservés.', 'All rights reserved.'],
    ['Fidelopass — Cartes de fidélité dématérialisées', 'Fidelopass — Digital loyalty cards'],
    ['Cartes de fidélité dématérialisées', 'Digital loyalty cards'],

    ['Espace commerçant', 'Merchant workspace'],
    ['Plan actif', 'Active plan'],
    ['Point de vente', 'Location'],
    ['Points de vente', 'Locations'],
    ['Tableau de bord', 'Dashboard'],
    ['Dashboard', 'Dashboard'],
    ['Ma carte', 'My card'],
    ['Scan caisse', 'Checkout scan'],
    ['Clients', 'Customers'],
    ['Historique', 'History'],
    ['Assistant carte', 'Card assistant'],
    ['Mon compte commerçant', 'Merchant account'],
    ['Ouvrir le scanner', 'Open scanner'],
    ['Se déconnecter', 'Log out'],
    ['Rafraîchir', 'Refresh'],
    ['À quoi ça sert ?', 'What is this for?'],
    ['Votre cockpit quotidien', 'Your daily cockpit'],
    ['Créer et faire évoluer votre carte', 'Create and improve your card'],
    ['Scanner vite en caisse', 'Scan quickly at checkout'],
    ['Faire revenir vos clients', 'Bring your customers back'],
    ['Gérer vos lieux indépendamment', 'Manage each location independently'],
    ['Comprendre votre base fidèle', 'Understand your loyal customer base'],
    ['Suivre ce qui se passe en caisse', 'Track checkout activity'],
    ['Piloter votre compte commerçant', 'Manage your merchant account'],
    ['Confier le design à notre équipe', 'Let our team design your card'],
    ['Votre cockpit quotidien', 'Your daily cockpit'],
    ['Tout ce qui compte aujourd’hui: scanner, partager la carte, suivre l’activité.', 'Everything that matters today: scan, share the card, track activity.'],
    ["Tout ce qui compte aujourd'hui: scanner, partager la carte, suivre l’activité.", 'Everything that matters today: scan, share the card, track activity.'],
    ['Activité en cours', 'Current activity'],
    ['passage validé aujourd’hui.', 'validated visit today.'],
    ["passage validé aujourd'hui.", 'validated visit today.'],
    ['Continuer à scanner', 'Keep scanning'],
    ['Voir l’historique', 'View history'],
    ["Voir l'historique", 'View history'],
    ['Personnaliser la carte', 'Customize the card'],
    ['Envoyer une notification', 'Send a notification'],
    ['Installer le scanner', 'Install the scanner'],
    ['Changer de point de vente', 'Change location'],
    ['Créer', 'Create'],
    ['Relancer', 'Reactivate'],
    ['Équipe', 'Team'],
    ['Caisse', 'Checkout'],
    ['Lieu actif', 'Active location'],
    ['Clients actifs', 'Active customers'],
    ['Passages aujourd’hui', 'Visits today'],
    ["Passages aujourd'hui", 'Visits today'],
    ['Récompenses offertes', 'Rewards given'],
    ['Retour client 30J', '30-day customer return'],

    ['Parcours guidé', 'Guided flow'],
    ['Type', 'Type'],
    ['Identité', 'Identity'],
    ['Programme', 'Program'],
    ['Apparence', 'Appearance'],
    ['Messages', 'Messages'],
    ['Options', 'Options'],
    ['Partage', 'Sharing'],
    ['Validé', 'Validated'],
    ['En cours', 'In progress'],
    ['À faire', 'To do'],
    ['Brouillon enregistré', 'Draft saved'],
    ['Brouillon non enregistré', 'Unsaved draft'],
    ['Étape précédente', 'Previous step'],
    ['Enregistrer et continuer', 'Save and continue'],
    ['Passer sans enregistrer', 'Continue without saving'],
    ['Modèles rapides', 'Quick templates'],
    ['Aucun modèle', 'No template'],
    ['Voir plus de modèles', 'Show more templates'],
    ['Thème', 'Theme'],
    ['Bannière', 'Banner'],
    ['Code-barres', 'Barcode'],
    ['Couleur de fond', 'Background color'],
    ['Fond', 'Background'],
    ['Texte', 'Text'],
    ['Accent', 'Accent'],
    ['Dégradé', 'Gradient'],
    ['Uni', 'Solid'],
    ['Pattern', 'Pattern'],
    ['Aperçu temps réel', 'Live preview'],
    ['Résumé de la carte', 'Card summary'],
    ['Nom du commerce', 'Business name'],
    ['Adresse complète', 'Full address'],
    ['Téléphone', 'Phone'],
    ['Email de contact', 'Contact email'],
    ['Récompense', 'Reward'],
    ['Récompenses disponibles', 'Available rewards'],
    ['Texte d’accueil public', 'Public welcome text'],
    ["Texte d'accueil public", 'Public welcome text'],
    ['Message après ajout Wallet', 'Message after Wallet add'],

    ['Nouveau message client', 'New customer message'],
    ['Titre', 'Title'],
    ['Message', 'Message'],
    ['Envoyer le message', 'Send message'],
    ['Canal Wallet', 'Wallet channel'],
    ['Avis Google automatique (+1h)', 'Automatic Google review (+1h)'],
    ['Anniversaire automatique', 'Automatic birthday reward'],
    ['Activer', 'Enable'],
    ['Désactiver', 'Disable'],
    ['Plan actuel', 'Current plan'],
    ['Pro uniquement', 'Pro only'],
    ['Historique des messages', 'Message history'],

    ['Scannez le pass client', 'Scan the customer pass'],
    ['Nouveau scan', 'New scan'],
    ['Ajouter un point', 'Add one point'],
    ['+1 point', '+1 point'],
    ['+1 tampon', '+1 stamp'],
    ['Utiliser récompense', 'Redeem reward'],
    ['Aucun client trouvé pour ce code.', 'No customer found for this code.'],
    ['Scan vide, veuillez réessayer.', 'Empty scan, please try again.'],
    ['Erreur serveur, veuillez réessayer.', 'Server error, please try again.'],
    ['Le client n’a pas encore assez de points pour utiliser une récompense.', 'The customer does not have enough points to redeem a reward yet.'],

    ['Service premium', 'Premium service'],
    ['Accompagnement Setup', 'Setup assistance'],
    ['Acheter l’accompagnement', 'Buy setup assistance'],
    ["Acheter l'accompagnement", 'Buy setup assistance'],
    ['Accompagnement déjà activé', 'Setup assistance already active'],
    ['Brief design', 'Design brief'],
    ['Dites-nous quoi créer', 'Tell us what to create'],
    ['Envoyer mon brief', 'Send my brief'],
    ['Éléments envoyés', 'Files sent'],
    ['Carte en cours de création', 'Card being created'],
    ['Carte créée', 'Card created'],
    ['Carte publiée', 'Card published'],

    ['Choisissez votre plan pour activer l’accès à l’outil.', 'Choose your plan to activate access to the tool.'],
    ["Choisissez votre plan pour activer l'accès à l'outil.", 'Choose your plan to activate access to the tool.'],
    ['Mensuel', 'Monthly'],
    ['Annuel', 'Annual'],
    ['Paiement annuel', 'Annual payment'],
    ['Mensuel sur 12 mois', 'Monthly over 12 months'],
    ['En une fois', 'One-time annual payment'],
    ['Résiliable à tout moment', 'Cancelable anytime'],
    ['Engagement 12 mois', '12-month commitment'],
    ['Le plus choisi', 'Most popular'],
    ['Sur mesure', 'Custom'],
    ['Démarrer', 'Start'],
    ['Continuer', 'Continue'],
    ['Configurer votre commerce', 'Set up your business'],
    ['Bienvenue', 'Welcome'],

    ['Admin', 'Admin'],
    ['Vue globale', 'Overview'],
    ['Commerces', 'Businesses'],
    ['Partenaires', 'Partners'],
    ['Assistance cartes', 'Card assistance'],
    ['Retour espace commerçant', 'Back to merchant workspace'],
    ['Exporter la base', 'Export database'],
    ['Commerces récents', 'Recent businesses'],
    ['Abonnement', 'Subscription'],
    ['Statut', 'Status'],
    ['Création', 'Created'],
    ['Action', 'Action'],
    ['Désactiver', 'Disable'],
    ['Actif', 'Active'],
    ['Inactif', 'Inactive'],

    ['Vue partenaire', 'Partner overview'],
    ['Commerces clients', 'Client businesses'],
    ['White label', 'White label'],
    ['Partenaire white label', 'White-label partner'],
  ];

  const placeholderEntries = [
    ['Ex: Offre du weekend !', 'E.g. Weekend offer!'],
    ['Ex: -20% sur tout le magasin ce samedi uniquement 🎉', 'E.g. 20% off the whole store this Saturday only 🎉'],
    ['Rechercher un client...', 'Search for a customer...'],
    ['Scannez le pass client', 'Scan the customer pass'],
    ['Adresse complète', 'Full address'],
    ['Nom du commerce', 'Business name'],
    ['Téléphone', 'Phone'],
    ['Email de contact', 'Contact email'],
  ];

  const dictionary = new Map(entries);
  const placeholderDictionary = new Map(placeholderEntries);
  const sortedEntries = entries.slice().sort((a, b) => b[0].length - a[0].length);

  function getInitialLanguage() {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (SUPPORTED_LANGUAGES.has(saved)) return saved;
    } catch {
      // localStorage best effort
    }
    return 'fr';
  }

  function setStoredLanguage(language) {
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // localStorage best effort
    }
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function preserveWhitespace(original, translated) {
    const prefix = original.match(/^\s*/)?.[0] ?? '';
    const suffix = original.match(/\s*$/)?.[0] ?? '';
    return `${prefix}${translated}${suffix}`;
  }

  function translateText(value) {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (!compact) return value;

    const exact = dictionary.get(compact);
    if (exact) return preserveWhitespace(value, exact);

    let translated = value;
    for (const [source, target] of sortedEntries) {
      const pattern = new RegExp(escapeRegExp(source), 'g');
      translated = translated.replace(pattern, target);
    }
    return translated;
  }

  function shouldSkipNode(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (SKIP_TAGS.has(parent.tagName)) return true;
    if (parent.closest(SKIP_SELECTOR)) return true;
    if (parent.isContentEditable) return true;
    return false;
  }

  function walkAndTranslate(root, language) {
    if (!root || root.closest?.(SKIP_SELECTOR)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      if (node.__fpOriginalText === undefined) node.__fpOriginalText = node.nodeValue;
      node.nodeValue = language === 'fr' ? node.__fpOriginalText : translateText(node.__fpOriginalText);
    }
  }

  function translateAttributes(language) {
    const selector = 'input[placeholder], textarea[placeholder], [aria-label], [title]';
    document.querySelectorAll(selector).forEach((element) => {
      if (element.closest(SKIP_SELECTOR)) return;
      for (const attr of ['placeholder', 'aria-label', 'title']) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        const key = `__fpOriginal${attr}`;
        if (!element[key]) element[key] = value;
        const original = element[key];
        const translated = placeholderDictionary.get(original) ?? translateText(original);
        element.setAttribute(attr, language === 'fr' ? original : translated);
      }
    });
  }

  function updateButtons(language) {
    document.querySelectorAll('[data-fp-language-button]').forEach((button) => {
      const active = button.getAttribute('data-fp-language-button') === language;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function syncTitle(language) {
    if (document.__fpOriginalTitle === undefined || document.title !== document.__fpTranslatedTitle) {
      document.__fpOriginalTitle = document.title;
    }

    const nextTitle = language === 'fr' ? document.__fpOriginalTitle : translateText(document.__fpOriginalTitle);
    document.__fpTranslatedTitle = nextTitle;
    document.title = nextTitle;
  }

  function applyLanguage(language) {
    const safeLanguage = SUPPORTED_LANGUAGES.has(language) ? language : 'fr';
    document.documentElement.lang = safeLanguage;
    document.documentElement.dataset.language = safeLanguage;
    syncTitle(safeLanguage);
    walkAndTranslate(document.body, safeLanguage);
    translateAttributes(safeLanguage);
    updateButtons(safeLanguage);
  }

  let currentLanguage = getInitialLanguage();
  let observer;
  let scheduled = false;

  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      applyLanguage(currentLanguage);
    });
  }

  function setLanguage(language) {
    currentLanguage = SUPPORTED_LANGUAGES.has(language) ? language : 'fr';
    setStoredLanguage(currentLanguage);
    applyLanguage(currentLanguage);
  }

  function init() {
    document.querySelectorAll('[data-fp-language-button]').forEach((button) => {
      button.addEventListener('click', () => {
        setLanguage(button.getAttribute('data-fp-language-button') || 'fr');
      });
    });

    applyLanguage(currentLanguage);
    observer = new MutationObserver((mutations) => {
      if (currentLanguage === 'fr') return;
      if (mutations.some((mutation) => mutation.addedNodes.length || mutation.type === 'childList')) scheduleApply();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.FideloPassI18n = {
    setLanguage,
    getLanguage: () => currentLanguage,
    apply: () => applyLanguage(currentLanguage),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
