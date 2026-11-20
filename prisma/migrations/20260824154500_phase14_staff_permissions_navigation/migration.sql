-- CODIQ Phase 14 — staff identity, store membership, staff sessions, permission overrides,
-- and email-conflict protection across platform owners, merchants, and staff.
-- This file mirrors the SQL already applied to the Neon staging branch on 2026-08-24
-- (recorded there in _prisma_migrations under this exact migration name).

BEGIN;

CREATE TABLE staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_email_normalized CHECK (email = lower(btrim(email)))
);

CREATE TABLE store_staff_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  role_code TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  permission_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT store_staff_memberships_unique_staff_store UNIQUE (staff_id, store_id),
  CONSTRAINT store_staff_memberships_unique_identity_context UNIQUE (id, staff_id, store_id),
  CONSTRAINT store_staff_memberships_role_code CHECK (role_code IN ('store_manager', 'store_staff')),
  CONSTRAINT store_staff_memberships_permission_version_positive CHECK (permission_version > 0)
);

CREATE INDEX store_staff_memberships_store_id_idx ON store_staff_memberships(store_id);
CREATE INDEX store_staff_memberships_staff_id_idx ON store_staff_memberships(staff_id);
CREATE INDEX store_staff_memberships_active_store_idx ON store_staff_memberships(store_id, is_active);

CREATE TABLE staff_membership_permission_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id UUID NOT NULL REFERENCES store_staff_memberships(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL,
  effect TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_membership_permission_overrides_unique UNIQUE (membership_id, permission_code),
  CONSTRAINT staff_membership_permission_overrides_effect CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT staff_membership_permission_overrides_code CHECK (permission_code IN (
    'catalog.products.view',
    'catalog.products.create',
    'catalog.products.update',
    'catalog.products.delete',
    'catalog.categories.manage',
    'inventory.update',
    'orders.view',
    'orders.update',
    'customers.view',
    'team.manage',
    'settings.manage'
  ))
);

CREATE INDEX staff_membership_permission_overrides_membership_idx
  ON staff_membership_permission_overrides(membership_id);

CREATE TABLE staff_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL,
  membership_id UUID NOT NULL,
  store_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_sessions_expiry CHECK (expires_at > created_at),
  CONSTRAINT staff_sessions_membership_context_fk
    FOREIGN KEY (membership_id, staff_id, store_id)
    REFERENCES store_staff_memberships(id, staff_id, store_id)
    ON DELETE RESTRICT
);

CREATE INDEX staff_sessions_staff_id_idx ON staff_sessions(staff_id);
CREATE INDEX staff_sessions_membership_id_idx ON staff_sessions(membership_id);
CREATE INDEX staff_sessions_store_id_idx ON staff_sessions(store_id);

-- One advisory lock serializes all cross-identity email writes for a normalized email.
CREATE OR REPLACE FUNCTION codiq_guard_owner_merchant_staff_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.email, 0));

  IF TG_TABLE_NAME = 'platform_owners' THEN
    IF EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, merchant, or staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'merchants' THEN
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, merchant, or staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'staff' THEN
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, merchant, or staff identities';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_owners_guard_owner_merchant_email ON platform_owners;
DROP TRIGGER IF EXISTS merchants_guard_owner_merchant_email ON merchants;

CREATE TRIGGER platform_owners_guard_owner_merchant_staff_email
BEFORE INSERT OR UPDATE OF email ON platform_owners
FOR EACH ROW EXECUTE FUNCTION codiq_guard_owner_merchant_staff_email();

CREATE TRIGGER merchants_guard_owner_merchant_staff_email
BEFORE INSERT OR UPDATE OF email ON merchants
FOR EACH ROW EXECUTE FUNCTION codiq_guard_owner_merchant_staff_email();

CREATE TRIGGER staff_guard_owner_merchant_staff_email
BEFORE INSERT OR UPDATE OF email ON staff
FOR EACH ROW EXECUTE FUNCTION codiq_guard_owner_merchant_staff_email();

COMMIT;
