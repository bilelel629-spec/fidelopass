ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS date_naissance DATE;

CREATE INDEX IF NOT EXISTS idx_clients_date_naissance
  ON clients(date_naissance)
  WHERE date_naissance IS NOT NULL;
