-- =====================================================
-- Fidelopass — Multi points de vente (Starter=1, Pro=3)
-- =====================================================

CREATE TABLE IF NOT EXISTS points_vente (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_id UUID NOT NULL REFERENCES commerces(id) ON DELETE CASCADE,
  nom VARCHAR(255) NOT NULL,
  adresse TEXT,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  rayon_geo INTEGER DEFAULT 1000,
  principal BOOLEAN DEFAULT false,
  actif BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_points_vente_commerce ON points_vente(commerce_id);
CREATE INDEX IF NOT EXISTS idx_points_vente_actif ON points_vente(commerce_id, actif);
CREATE UNIQUE INDEX IF NOT EXISTS idx_points_vente_principal_unique
  ON points_vente(commerce_id)
  WHERE principal = true;

ALTER TABLE points_vente ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "points_vente_owner" ON points_vente;
CREATE POLICY "points_vente_owner" ON points_vente
  FOR ALL USING (
    commerce_id IN (
      SELECT id FROM commerces WHERE user_id = auth.uid()
    )
  );

DROP TRIGGER IF EXISTS points_vente_updated_at ON points_vente;
CREATE TRIGGER points_vente_updated_at BEFORE UPDATE ON points_vente
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 1) Créer un point de vente principal pour chaque commerce existant
INSERT INTO points_vente (commerce_id, nom, adresse, latitude, longitude, rayon_geo, principal, actif)
SELECT
  c.id,
  CONCAT(c.nom, ' — Principal'),
  c.adresse,
  c.latitude,
  c.longitude,
  COALESCE(c.rayon_geo, 1000),
  true,
  true
FROM commerces c
WHERE NOT EXISTS (
  SELECT 1 FROM points_vente pv WHERE pv.commerce_id = c.id
);

-- 2) Garantir un seul principal actif par commerce
WITH ranked AS (
  SELECT
    id,
    commerce_id,
    ROW_NUMBER() OVER (PARTITION BY commerce_id ORDER BY principal DESC, created_at ASC) AS rn
  FROM points_vente
  WHERE actif = true
)
UPDATE points_vente pv
SET principal = (ranked.rn = 1)
FROM ranked
WHERE pv.id = ranked.id;

-- 3) Colonnes de liaison point_vente_id
ALTER TABLE cartes ADD COLUMN IF NOT EXISTS point_vente_id UUID REFERENCES points_vente(id) ON DELETE CASCADE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS point_vente_id UUID REFERENCES points_vente(id) ON DELETE CASCADE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS point_vente_id UUID REFERENCES points_vente(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS point_vente_id UUID REFERENCES points_vente(id) ON DELETE CASCADE;
ALTER TABLE scanner_devices ADD COLUMN IF NOT EXISTS point_vente_id UUID REFERENCES points_vente(id) ON DELETE CASCADE;

-- 4) Backfill point_vente_id sur les données historiques
WITH principal_point AS (
  SELECT DISTINCT ON (commerce_id) id, commerce_id
  FROM points_vente
  WHERE actif = true
  ORDER BY commerce_id, principal DESC, created_at ASC
)
UPDATE cartes c
SET point_vente_id = p.id
FROM principal_point p
WHERE c.commerce_id = p.commerce_id
  AND c.point_vente_id IS NULL;

WITH principal_point AS (
  SELECT DISTINCT ON (commerce_id) id, commerce_id
  FROM points_vente
  WHERE actif = true
  ORDER BY commerce_id, principal DESC, created_at ASC
)
UPDATE clients c
SET point_vente_id = p.id
FROM principal_point p
WHERE c.commerce_id = p.commerce_id
  AND c.point_vente_id IS NULL;

WITH principal_point AS (
  SELECT DISTINCT ON (commerce_id) id, commerce_id
  FROM points_vente
  WHERE actif = true
  ORDER BY commerce_id, principal DESC, created_at ASC
)
UPDATE transactions t
SET point_vente_id = p.id
FROM principal_point p
WHERE t.commerce_id = p.commerce_id
  AND t.point_vente_id IS NULL;

WITH principal_point AS (
  SELECT DISTINCT ON (commerce_id) id, commerce_id
  FROM points_vente
  WHERE actif = true
  ORDER BY commerce_id, principal DESC, created_at ASC
)
UPDATE notifications n
SET point_vente_id = p.id
FROM principal_point p
WHERE n.commerce_id = p.commerce_id
  AND n.point_vente_id IS NULL;

WITH principal_point AS (
  SELECT DISTINCT ON (commerce_id) id, commerce_id
  FROM points_vente
  WHERE actif = true
  ORDER BY commerce_id, principal DESC, created_at ASC
)
UPDATE scanner_devices s
SET point_vente_id = p.id
FROM principal_point p
WHERE s.commerce_id = p.commerce_id
  AND s.point_vente_id IS NULL;

-- 5) Contraintes et index multi-point de vente
ALTER TABLE cartes ALTER COLUMN point_vente_id SET NOT NULL;
ALTER TABLE clients ALTER COLUMN point_vente_id SET NOT NULL;
ALTER TABLE transactions ALTER COLUMN point_vente_id SET NOT NULL;
ALTER TABLE notifications ALTER COLUMN point_vente_id SET NOT NULL;
ALTER TABLE scanner_devices ALTER COLUMN point_vente_id SET NOT NULL;

DROP INDEX IF EXISTS idx_cartes_commerce;
CREATE INDEX IF NOT EXISTS idx_cartes_commerce ON cartes(commerce_id);
CREATE INDEX IF NOT EXISTS idx_cartes_point_vente ON cartes(point_vente_id);

DROP INDEX IF EXISTS idx_clients_commerce;
CREATE INDEX IF NOT EXISTS idx_clients_commerce ON clients(commerce_id);
CREATE INDEX IF NOT EXISTS idx_clients_point_vente ON clients(point_vente_id);

CREATE INDEX IF NOT EXISTS idx_transactions_point_vente ON transactions(point_vente_id);
CREATE INDEX IF NOT EXISTS idx_notifications_point_vente ON notifications(point_vente_id);
CREATE INDEX IF NOT EXISTS idx_scanner_devices_point_vente ON scanner_devices(point_vente_id);

ALTER TABLE cartes DROP CONSTRAINT IF EXISTS cartes_commerce_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cartes_point_vente_unique ON cartes(point_vente_id);

ALTER TABLE scanner_devices DROP CONSTRAINT IF EXISTS scanner_devices_commerce_id_scanner_token_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scanner_devices_point_token_unique
  ON scanner_devices(point_vente_id, scanner_token);
