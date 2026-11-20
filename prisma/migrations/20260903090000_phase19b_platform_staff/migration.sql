-- المرحلة 19-ب (ق-143) — «طاقم المنصة»: الهوية الخامسة على المنصة.
--
-- One platform, no tenant boundary: the membership COLLAPSES into the staff row
-- itself (role_code lives here, not in a join table). Removal is a soft
-- deleted_at WITHOUT the trash-bin machinery — there is no restore surface; the
-- owner re-creates the account if he changes his mind.

CREATE TABLE platform_staff (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  role_code          TEXT NOT NULL,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  permission_version INTEGER NOT NULL DEFAULT 1,
  -- ق-124: TOTP is MANDATORY for platform staff. The pair CHECK keeps the
  -- unreachable state unreachable: enabled with no secret cannot be written.
  totp_secret        TEXT,
  totp_enabled_at    TIMESTAMPTZ,
  totp_last_step     BIGINT,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_staff_role_code CHECK (role_code IN ('registrations_admin', 'accountant', 'supervisor')),
  CONSTRAINT platform_staff_totp_pair CHECK (totp_enabled_at IS NULL OR totp_secret IS NOT NULL)
);

CREATE TABLE platform_staff_permission_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id        uuid NOT NULL REFERENCES platform_staff(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL,
  effect          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_staff_permission_overrides_effect CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT platform_staff_permission_overrides_unique UNIQUE (staff_id, permission_code)
);

CREATE INDEX platform_staff_permission_overrides_staff_idx
  ON platform_staff_permission_overrides(staff_id);

-- The FIFTH session table. The four-table separation in session.service.ts is
-- deliberate — a platform-staff session is structurally incapable of being any
-- other identity's session — so the fifth follows the same shape, device column
-- and all.
CREATE TABLE platform_staff_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_staff_id uuid NOT NULL REFERENCES platform_staff(id) ON DELETE RESTRICT,
  token_hash        TEXT NOT NULL UNIQUE,
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  user_agent        TEXT,
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_staff_sessions_expiry CHECK (expires_at > created_at)
);

CREATE INDEX platform_staff_sessions_staff_idx ON platform_staff_sessions(platform_staff_id);

-- «مَن فعل ماذا على مستوى المنصة» — append-only, like the store audit log and
-- the ledger before it. TEXT label snapshots, not joins: the staff member may
-- be removed and the merchant purged, and a line reading «by 8f2c…» is
-- worthless a year later. NO purge, ever: this is the record the owner reads
-- when he asks what his own staff did with his own platform.
CREATE TABLE platform_audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT NOT NULL,
  -- Nullable on purpose: registration_mode and the brand logo are singletons
  -- with no row of their own to point at.
  entity_id    uuid,
  entity_label TEXT NOT NULL,
  action       TEXT NOT NULL,
  actor_kind   TEXT NOT NULL,
  actor_id     uuid NOT NULL,
  actor_label  TEXT NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_audit_events_entity_type CHECK (entity_type IN
    ('merchant', 'plan', 'subscription', 'upgrade_request', 'settlement', 'ledger_adjustment',
     'registration_mode', 'platform_staff', 'brand')),
  CONSTRAINT platform_audit_events_action CHECK (action IN
    ('registration_decided', 'registration_mode_changed', 'merchant_created_manually',
     'subscription_assigned', 'plan_created', 'plan_updated', 'upgrade_request_decided',
     'settlement_created', 'adjustment_created', 'logo_changed', 'logo_cleared',
     'staff_created', 'staff_updated', 'staff_overrides_changed', 'staff_removed',
     'staff_totp_reset')),
  CONSTRAINT platform_audit_events_actor_kind CHECK (actor_kind IN ('platform_owner', 'platform_staff'))
);

-- Keyset pagination on (created_at DESC, id DESC) like every other platform list.
CREATE INDEX platform_audit_events_created_idx
  ON platform_audit_events (created_at DESC, id DESC);

-- Append-only in the database, not merely in code (the
-- codiq_prevent_store_audit_event_mutation pattern, migration 20260828090100).
-- Unlike the store log there is NO cascade escape: nothing deletes the platform,
-- so nothing may delete its record.
CREATE OR REPLACE FUNCTION codiq_prevent_platform_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CODIQ_AUDIT_EVENT_IMMUTABLE: platform audit events are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER platform_audit_events_immutable
BEFORE UPDATE OR DELETE ON platform_audit_events
FOR EACH ROW EXECUTE FUNCTION codiq_prevent_platform_audit_event_mutation();

-- ---------------------------------------------------------------------------
-- Attribution widenings: a settlement or an upgrade decision made by staff is
-- recorded as made by THAT staff member, never laundered through the owner.
-- ---------------------------------------------------------------------------

ALTER TABLE settlements ALTER COLUMN platform_owner_id DROP NOT NULL;
ALTER TABLE settlements ADD COLUMN settled_by_staff_id uuid REFERENCES platform_staff(id) ON DELETE RESTRICT;
ALTER TABLE settlements ADD COLUMN settled_by_label TEXT;
-- Exactly one of the two actors must be recorded — a settlement nobody made
-- cannot exist. Every pre-existing row has platform_owner_id and passes as-is.
ALTER TABLE settlements ADD CONSTRAINT settlements_settled_by_one_of
  CHECK (platform_owner_id IS NOT NULL OR settled_by_staff_id IS NOT NULL);
CREATE INDEX settlements_settled_by_staff_idx ON settlements(settled_by_staff_id);

ALTER TABLE plan_upgrade_requests ADD COLUMN decided_by_staff_id uuid REFERENCES platform_staff(id) ON DELETE SET NULL;
ALTER TABLE plan_upgrade_requests ADD COLUMN decided_by_label TEXT;
CREATE INDEX plan_upgrade_requests_decided_by_staff_idx ON plan_upgrade_requests(decided_by_staff_id);

-- ---------------------------------------------------------------------------
-- The cross-identity email guard learns the fourth identity table. CREATE OR
-- REPLACE keeps the SAME advisory-lock line — a parallel trigger with its own
-- lock would race the existing three tables instead of serializing with them.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION codiq_guard_owner_merchant_staff_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.email, 0));

  IF TG_TABLE_NAME = 'platform_owners' THEN
    IF EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM platform_staff WHERE email = NEW.email) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'merchants' THEN
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM platform_staff WHERE email = NEW.email) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'staff' THEN
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM platform_staff WHERE email = NEW.email) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'platform_staff' THEN
    -- Same-table duplicates are the UNIQUE constraint's job; this branch guards
    -- the CROSS-identity claim only.
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_staff_guard_owner_merchant_staff_email
BEFORE INSERT OR UPDATE OF email ON platform_staff
FOR EACH ROW EXECUTE FUNCTION codiq_guard_owner_merchant_staff_email();
