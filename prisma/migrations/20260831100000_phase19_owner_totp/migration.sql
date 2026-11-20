-- Phase 19-أ — a second factor on the platform owner's account (ق-48, ق-123).
--
-- TOTP, decided in ق-123: an authenticator app on his phone. No message channel
-- exists (no SMS, and email is deferred by ق-121), so a code that has to be
-- DELIVERED could not be delivered at all — while ق-48 demands a factor that is
-- actually enabled, not scaffolding for later.
--
-- ============================================================================
-- RECOVERY CODES ARE NOT OPTIONAL HERE
-- ============================================================================
--
-- This platform has ONE owner. If he loses the phone holding the authenticator
-- and there is no other way in, nobody on earth can restore his access to his
-- own platform — there is no support desk above him, and no second owner to
-- vouch for him. A second factor without a recovery path does not secure the
-- account, it holds it hostage.
--
-- Ten single-use codes, hashed exactly like passwords (bcrypt, never plaintext),
-- shown once at enrolment. `used_at` rather than deletion, so "one of my
-- recovery codes was spent" is a fact he can see rather than an absence.
--
-- ============================================================================
-- THE SECRET IS STORED AS IT IS, AND THAT IS A KNOWN GAP
-- ============================================================================
--
-- Encryption at rest is 19-د, later in this same phase. Recording it here rather
-- than leaving it implied: anyone with a database dump today can mint valid
-- codes. The threat model that makes TOTP worth having — a stolen password — is
-- unaffected, but a dump is not, and 19-د must revisit this column by name.

ALTER TABLE platform_owners
  ADD COLUMN IF NOT EXISTS totp_secret     text,
  ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz(6),
  -- The last time step accepted for this account. What makes a code single-use:
  -- a code from a step already spent is refused even though the arithmetic still
  -- says it is valid, so one read over a shoulder is not ninety usable seconds.
  ADD COLUMN IF NOT EXISTS totp_last_step  bigint;

DO $$
BEGIN
  -- Enabled means enrolled: a factor that is "on" with no secret is an account
  -- that can never be signed into again.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_owners_totp_ck') THEN
    ALTER TABLE platform_owners ADD CONSTRAINT platform_owners_totp_ck
      CHECK (totp_enabled_at IS NULL OR totp_secret IS NOT NULL);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS platform_owner_recovery_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_owner_id uuid NOT NULL REFERENCES platform_owners (id) ON DELETE CASCADE,
  -- bcrypt, exactly like a password. A recovery code IS a password: it is the
  -- one thing that gets past the second factor.
  code_hash         text NOT NULL,
  used_at           timestamptz(6),
  created_at        timestamptz(6) NOT NULL DEFAULT now()
);

-- The unused ones, for "how many do I have left" and for the check at sign-in.
CREATE INDEX IF NOT EXISTS platform_owner_recovery_codes_unused_idx
  ON platform_owner_recovery_codes (platform_owner_id) WHERE used_at IS NULL;

COMMENT ON COLUMN platform_owners.totp_secret IS
  'Phase 19: TOTP shared secret, base32. STORED IN CLEAR — encryption at rest is 19-د, which must revisit this column by name.';
COMMENT ON TABLE platform_owner_recovery_codes IS
  'Phase 19: single-use ways past the second factor. Mandatory: this platform has one owner and no support desk above him.';
