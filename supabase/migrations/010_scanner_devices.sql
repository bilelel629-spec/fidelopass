-- Migration 010 : gestion des appareils scanner par commerce
CREATE TABLE IF NOT EXISTS scanner_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_id UUID NOT NULL REFERENCES commerces(id) ON DELETE CASCADE,
  scanner_token TEXT NOT NULL,
  device_name VARCHAR(120),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (commerce_id, scanner_token)
);

CREATE INDEX IF NOT EXISTS idx_scanner_devices_commerce ON scanner_devices(commerce_id);

ALTER TABLE scanner_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scanner_devices_owner" ON scanner_devices
  FOR ALL USING (
    commerce_id IN (
      SELECT id FROM commerces WHERE user_id = auth.uid()
    )
  );
