-- ق-227 — a store employee who leaves must not keep his email hostage.
--
-- ============================================================================
-- THE DEFECT
-- ============================================================================
--
-- `staff.email` carried a plain UNIQUE, and the four-identity trigger
-- (`codiq_guard_owner_merchant_staff_email`) reads that table with no filter. A
-- store removes a MEMBERSHIP — never the staff identity, by design: «a store does
-- not get to delete a human being who may work in other stores» — so the `staff`
-- row survives every removal, forever.
--
-- The consequence is the one PS-1/ق-143 closed for `platform_staff` and left open
-- here: ANY merchant, on the free plan, can permanently burn ANY email address
-- across all four identities on this platform. He adds a staff member with
-- victim@example.com, removes the membership a minute later, and from then on
-- that address can never become a merchant, never become a platform owner, never
-- become platform staff, and never be added as staff in any other shop. The
-- victim cannot register; the platform has no way to release it short of a
-- hand-written DELETE. It costs the attacker one free account and one API call.
--
-- ============================================================================
-- THE FIX, AND WHY IT IS THE SAME SHAPE AS ق-143
-- ============================================================================
--
-- Uniqueness is a claim on the LIVING — the PG-2 idiom behind
-- `products_store_sku_live_key` and its siblings, and behind
-- `platform_staff_email_live_key`. A staff identity whose last live membership is
-- gone is soft-deleted (`deleted_at`), and both readers of the email — the unique
-- index and the cross-identity trigger — see living rows only.
--
-- Both halves are required. Fixing one alone trades one wrong 23505 for another:
-- the index would release the address while the trigger still refused it, or the
-- reverse.
ALTER TABLE staff ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE staff DROP CONSTRAINT staff_email_key;

CREATE UNIQUE INDEX staff_email_live_key
  ON staff (email) WHERE deleted_at IS NULL;

-- The 4-way guard again, with `staff` now read the way `platform_staff` already
-- is. Every branch that asks «is this address claimed by a store employee?» asks
-- it of the LIVING; the `staff` branch itself keeps guarding the CROSS-identity
-- claim only, because same-table duplicates are the partial index's job.
CREATE OR REPLACE FUNCTION codiq_guard_owner_merchant_staff_email()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.email, 0));

  IF TG_TABLE_NAME = 'platform_owners' THEN
    IF EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM platform_staff WHERE email = NEW.email AND deleted_at IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'merchants' THEN
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM platform_staff WHERE email = NEW.email AND deleted_at IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'staff' THEN
    -- Same-table duplicates are the LIVE partial index's job now (ق-227); this
    -- branch guards the CROSS-identity claim only, exactly as the platform_staff
    -- branch has since ق-143.
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM platform_staff WHERE email = NEW.email AND deleted_at IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  ELSIF TG_TABLE_NAME = 'platform_staff' THEN
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email)
       OR EXISTS (SELECT 1 FROM staff WHERE email = NEW.email AND deleted_at IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email cannot be shared across platform owner, platform staff, merchant, or store staff identities';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
