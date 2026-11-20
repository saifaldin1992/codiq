-- MD-6 «متجر موثّق» — an owner-granted verification badge.
--
-- Additive only: three nullable columns on `stores`. Every existing store keeps
-- reading as unverified, which is the truth about them.
--
-- The verification is a CLAIM THE PLATFORM MAKES TO SHOPPERS, so the database
-- refuses to hold one that cannot be attributed: a store is either unverified,
-- or verified with a named owner and a moment. There is no third state in which
-- a badge is showing and nobody granted it.
--
-- Revocation clears all three columns rather than adding a `revoked_at`: the
-- question a storefront asks is "is this store verified right now", and the
-- history of grants and revocations belongs in store_audit_events, which
-- already records who did what to a store and is not rewritten.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS verified_at           timestamptz(6),
  ADD COLUMN IF NOT EXISTS verified_by_owner_id  uuid,
  ADD COLUMN IF NOT EXISTS verification_note     text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_verified_by_owner_fk') THEN
    ALTER TABLE stores
      ADD CONSTRAINT stores_verified_by_owner_fk
      FOREIGN KEY (verified_by_owner_id) REFERENCES platform_owners (id) ON DELETE RESTRICT;
  END IF;

  -- Both columns or neither: a badge always names the owner who granted it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_verification_attribution_ck') THEN
    ALTER TABLE stores
      ADD CONSTRAINT stores_verification_attribution_ck
      CHECK ((verified_at IS NULL) = (verified_by_owner_id IS NULL));
  END IF;

  -- A note without a verification is a note about nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_verification_note_ck') THEN
    ALTER TABLE stores
      ADD CONSTRAINT stores_verification_note_ck
      CHECK (verification_note IS NULL OR (verified_at IS NOT NULL AND btrim(verification_note) <> '' AND length(verification_note) <= 500));
  END IF;
END $$;

-- NOT serving any query that exists today: the storefront reads verification by
-- primary key, and the owner's directory lists every store rather than filtering
-- to verified ones. It is here for the "verified stores only" listing the owner
-- will want, and it is partial because that set stays far smaller than the whole.
-- Recorded plainly so nobody later reads it as evidence of a query it does not
-- have.
CREATE INDEX IF NOT EXISTS stores_verified_at_idx ON stores (verified_at DESC) WHERE verified_at IS NOT NULL;
