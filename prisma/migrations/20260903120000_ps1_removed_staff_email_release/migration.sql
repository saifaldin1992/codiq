-- 19-ب hardening (ق-143) — a REMOVED platform-staff member must not keep his
-- email hostage.
--
-- Found in adversarial review: `platform_staff.email` carried a plain UNIQUE,
-- and removal is a soft delete (deleted_at). So the address of anyone ever
-- removed stayed claimed forever — he could never be re-added, never become a
-- merchant, never be store staff, and the platform had no way to release it
-- short of a hand-written DELETE. That is exactly the failure the LIVE partial
-- indexes were invented for in PG-2 (products_store_sku_live_key and its four
-- siblings, migration 20260828090200): uniqueness is a claim on the LIVING.
--
-- Two halves, and both are required — the constraint AND the cross-identity
-- trigger read the same table with different filters, so fixing one alone
-- would trade a wrong 23505 for another.

ALTER TABLE platform_staff DROP CONSTRAINT platform_staff_email_key;

CREATE UNIQUE INDEX platform_staff_email_live_key
  ON platform_staff (email) WHERE deleted_at IS NULL;

-- The 4-way guard: every EXISTS on platform_staff now sees LIVING rows only.
-- The other three tables have no soft delete, so their EXISTS are unchanged.
CREATE OR REPLACE FUNCTION codiq_guard_owner_merchant_staff_email()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.email, 0));

  IF TG_TABLE_NAME = 'platform_owners' THEN
    IF EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM platform_staff WHERE email = NEW.email AND deleted_at IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'merchants' THEN
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM platform_staff WHERE email = NEW.email AND deleted_at IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'staff' THEN
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM platform_staff WHERE email = NEW.email AND deleted_at IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'platform_staff' THEN
    -- Same-table duplicates are the LIVE partial index's job now; this branch
    -- guards the CROSS-identity claim only.
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
