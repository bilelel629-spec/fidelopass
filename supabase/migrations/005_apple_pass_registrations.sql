-- Migration 005 : registrations Apple Wallet pour mises à jour de pass
CREATE TABLE IF NOT EXISTS apple_pass_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  device_library_identifier TEXT NOT NULL,
  pass_type_identifier TEXT NOT NULL,
  push_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, device_library_identifier, pass_type_identifier)
);

CREATE INDEX IF NOT EXISTS idx_apple_pass_registrations_client_id
  ON apple_pass_registrations(client_id);

CREATE INDEX IF NOT EXISTS idx_apple_pass_registrations_device
  ON apple_pass_registrations(device_library_identifier, pass_type_identifier);
