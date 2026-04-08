-- =====================================================
-- Fidelopass — Migration initiale
-- Exécuter dans l'éditeur SQL de Supabase
-- =====================================================

-- Table des commerces
CREATE TABLE IF NOT EXISTS commerces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  nom VARCHAR(255) NOT NULL,
  adresse TEXT,
  telephone VARCHAR(20),
  email VARCHAR(255),
  logo_url TEXT,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  rayon_geo INTEGER DEFAULT 1000,
  actif BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Table des cartes de fidélité
CREATE TABLE IF NOT EXISTS cartes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_id UUID REFERENCES commerces(id) ON DELETE CASCADE NOT NULL,
  nom VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(10) NOT NULL CHECK (type IN ('points', 'tampons')),
  tampons_total INTEGER DEFAULT 10,
  points_par_euro DECIMAL(5,2) DEFAULT 1,
  points_recompense INTEGER DEFAULT 100,
  recompense_description TEXT,
  couleur_fond VARCHAR(7) DEFAULT '#1a1a2e',
  couleur_texte VARCHAR(7) DEFAULT '#ffffff',
  couleur_accent VARCHAR(7) DEFAULT '#e94560',
  message_geo TEXT DEFAULT 'Votre carte de fidélité vous attend !',
  pass_type_id VARCHAR(255),
  qr_code_url TEXT,
  actif BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(commerce_id) -- un seul commerce = une seule carte
);

-- Table des clients
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carte_id UUID REFERENCES cartes(id) ON DELETE CASCADE NOT NULL,
  commerce_id UUID REFERENCES commerces(id) ON DELETE CASCADE NOT NULL,
  nom VARCHAR(255),
  telephone VARCHAR(20),
  email VARCHAR(255),
  points_actuels INTEGER DEFAULT 0,
  tampons_actuels INTEGER DEFAULT 0,
  recompenses_obtenues INTEGER DEFAULT 0,
  apple_pass_serial VARCHAR(255),
  google_pass_id VARCHAR(255),
  fcm_token TEXT,
  push_enabled BOOLEAN DEFAULT false,
  derniere_visite TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Table des transactions
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  commerce_id UUID REFERENCES commerces(id) ON DELETE CASCADE NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('ajout_points', 'ajout_tampon', 'recompense', 'reset')),
  valeur INTEGER NOT NULL,
  points_avant INTEGER,
  points_apres INTEGER,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Table des notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_id UUID REFERENCES commerces(id) ON DELETE CASCADE NOT NULL,
  titre VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(20) DEFAULT 'promo',
  nb_destinataires INTEGER DEFAULT 0,
  nb_delivrees INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- Index de performance
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_commerces_user ON commerces(user_id);
CREATE INDEX IF NOT EXISTS idx_cartes_commerce ON cartes(commerce_id);
CREATE INDEX IF NOT EXISTS idx_clients_carte ON clients(carte_id);
CREATE INDEX IF NOT EXISTS idx_clients_commerce ON clients(commerce_id);
CREATE INDEX IF NOT EXISTS idx_transactions_client ON transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_transactions_commerce ON transactions(commerce_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_commerce ON notifications(commerce_id);

-- =====================================================
-- Row Level Security (RLS)
-- =====================================================

ALTER TABLE commerces ENABLE ROW LEVEL SECURITY;
ALTER TABLE cartes ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Commerces : lecture/écriture uniquement pour le propriétaire
CREATE POLICY "commerces_owner" ON commerces
  FOR ALL USING (auth.uid() = user_id);

-- Cartes : lecture publique (pour la page /carte/[id]), écriture propriétaire via commerce
CREATE POLICY "cartes_public_read" ON cartes
  FOR SELECT USING (actif = true);

CREATE POLICY "cartes_owner_write" ON cartes
  FOR ALL USING (
    commerce_id IN (
      SELECT id FROM commerces WHERE user_id = auth.uid()
    )
  );

-- Clients : lecture/écriture via commerce du propriétaire + création publique
CREATE POLICY "clients_owner" ON clients
  FOR ALL USING (
    commerce_id IN (
      SELECT id FROM commerces WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "clients_public_insert" ON clients
  FOR INSERT WITH CHECK (true);

-- Transactions : lecture/écriture via commerce du propriétaire
CREATE POLICY "transactions_owner" ON transactions
  FOR ALL USING (
    commerce_id IN (
      SELECT id FROM commerces WHERE user_id = auth.uid()
    )
  );

-- Notifications : lecture/écriture via commerce du propriétaire
CREATE POLICY "notifications_owner" ON notifications
  FOR ALL USING (
    commerce_id IN (
      SELECT id FROM commerces WHERE user_id = auth.uid()
    )
  );

-- =====================================================
-- Trigger updated_at automatique
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commerces_updated_at BEFORE UPDATE ON commerces
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER cartes_updated_at BEFORE UPDATE ON cartes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
