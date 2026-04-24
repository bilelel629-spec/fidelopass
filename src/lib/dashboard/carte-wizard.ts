export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const TOTAL_WIZARD_STEPS: WizardStep = 7;

export const WIZARD_STEP_LABELS = ['Type', 'Identité', 'Programme', 'Apparence', 'Messages', 'Options', 'Partage'] as const;

export const WIZARD_STEP_TITLES = [
  'Type de programme',
  'Identité visuelle',
  'Programme fidélité',
  'Apparence',
  'Messages client',
  'Options',
  'Scanner & Partage',
] as const;

export const WIZARD_STEP_GUIDANCE = [
  {
    title: 'Choisissez le socle du programme',
    text: 'Tampons: le plus simple en caisse. Points: plus flexible pour offres évolutives.',
    required: 'Obligatoire: type de programme',
  },
  {
    title: 'Posez votre identité',
    text: 'Nom clair + logo bien centré = carte reconnue instantanément par le client.',
    required: 'Obligatoire: nom de carte',
  },
  {
    title: 'Définissez la promesse client',
    text: 'Fixez un objectif atteignable et une récompense qui donne envie de revenir vite.',
    required: 'Obligatoire: configuration programme + récompense',
  },
  {
    title: 'Habillez la carte en mode simple',
    text: 'Commencez par thème + bannière + QR. Les options avancées restent optionnelles.',
    required: 'Obligatoire: aucun (design libre)',
  },
  {
    title: 'Rassurez le client avec des messages courts',
    text: "Un accueil clair et un message post-ajout augmentent l'activation de la carte.",
    required: 'Obligatoire: aucun',
  },
  {
    title: 'Activez la proximité si utile',
    text: 'Géolocalisation: renseignez une adresse précise et un message utile en passage boutique.',
    required: 'Obligatoire si activé: adresse du commerce',
  },
  {
    title: 'Passez en mode opérationnel',
    text: 'Installez le scanner équipe puis affichez le QR client en caisse.',
    required: 'Obligatoire: carte déjà enregistrée',
  },
] as const;

export type StepValidationContext = {
  type: 'tampons' | 'points';
  nomCarte: string;
  recompense: string;
  tamponsTotal: number;
  pointsParEuro: number;
  pointsRecompense: number;
  geoEnabled: boolean;
  adresseCommerce: string;
};

export function validateWizardStep(step: WizardStep, context: StepValidationContext): string | null {
  if (step === 1) return null;

  if (step === 2) {
    return context.nomCarte.trim() ? null : 'Renseignez au minimum le nom de la carte.';
  }

  if (step === 3) {
    if (context.type === 'tampons') {
      if (!Number.isFinite(context.tamponsTotal) || context.tamponsTotal < 1) {
        return 'Le nombre de tampons doit être supérieur à 0.';
      }
    } else {
      if (!Number.isFinite(context.pointsParEuro) || context.pointsParEuro <= 0) {
        return 'Le ratio points/euro doit être supérieur à 0.';
      }
      if (!Number.isFinite(context.pointsRecompense) || context.pointsRecompense < 1) {
        return 'Le seuil de points doit être supérieur à 0.';
      }
    }
    return context.recompense.trim() ? null : 'Décrivez la récompense offerte au client.';
  }

  if (step === 6) {
    if (!context.geoEnabled) return null;
    return context.adresseCommerce.trim() ? null : 'Ajoutez l’adresse du commerce pour activer la géolocalisation.';
  }

  return null;
}
