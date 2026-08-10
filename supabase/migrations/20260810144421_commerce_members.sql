-- Acces equipe / comptes secondaires commerçants.
-- Un utilisateur Supabase Auth peut avoir son propre mot de passe et acceder au commerce d'un proprietaire.

CREATE TABLE IF NOT EXISTS commerce_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commerce_id UUID NOT NULL REFERENCES commerces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'admin', 'staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (commerce_id, user_id),
  UNIQUE (commerce_id, email)
);

CREATE INDEX IF NOT EXISTS idx_commerce_members_user_active
  ON commerce_members(user_id, status);

CREATE INDEX IF NOT EXISTS idx_commerce_members_commerce_active
  ON commerce_members(commerce_id, status);

INSERT INTO commerce_members (commerce_id, user_id, email, role, status, created_at, updated_at)
SELECT
  c.id,
  c.user_id,
  LOWER(COALESCE(au.email, c.email, c.user_id::TEXT)),
  'owner',
  'active',
  NOW(),
  NOW()
FROM commerces c
LEFT JOIN auth.users au ON au.id = c.user_id
WHERE c.user_id IS NOT NULL
ON CONFLICT (commerce_id, user_id) DO NOTHING;

DROP TRIGGER IF EXISTS commerce_members_updated_at ON commerce_members;
CREATE TRIGGER commerce_members_updated_at
  BEFORE UPDATE ON commerce_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE commerce_members ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_members TO authenticated;

DROP POLICY IF EXISTS commerce_members_self_select ON commerce_members;
CREATE POLICY commerce_members_self_select
  ON commerce_members
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS commerce_members_owner_select ON commerce_members;
CREATE POLICY commerce_members_owner_select
  ON commerce_members
  FOR SELECT
  TO authenticated
  USING (
    commerce_id IN (
      SELECT id
      FROM commerces
      WHERE user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS commerce_members_owner_insert ON commerce_members;
CREATE POLICY commerce_members_owner_insert
  ON commerce_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    role <> 'owner'
    AND
    commerce_id IN (
      SELECT id
      FROM commerces
      WHERE user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS commerce_members_owner_update ON commerce_members;
CREATE POLICY commerce_members_owner_update
  ON commerce_members
  FOR UPDATE
  TO authenticated
  USING (
    commerce_id IN (
      SELECT id
      FROM commerces
      WHERE user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    role <> 'owner'
    AND
    commerce_id IN (
      SELECT id
      FROM commerces
      WHERE user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS commerce_members_owner_delete ON commerce_members;
CREATE POLICY commerce_members_owner_delete
  ON commerce_members
  FOR DELETE
  TO authenticated
  USING (
    commerce_id IN (
      SELECT id
      FROM commerces
      WHERE user_id = (SELECT auth.uid())
    )
    AND role <> 'owner'
  );

DROP POLICY IF EXISTS commerces_member_select ON commerces;
CREATE POLICY commerces_member_select
  ON commerces
  FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT commerce_id
      FROM commerce_members
      WHERE user_id = (SELECT auth.uid())
        AND status = 'active'
    )
  );
