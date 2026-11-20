-- 19-د (D-40) — encryption at rest for the three columns that held somebody
-- else's secret in the clear.
--
-- ============================================================================
-- THIS MIGRATION CHANGES NO ROW, AND THAT IS NOT AN OVERSIGHT
-- ============================================================================
--
-- `20260831100000_phase19_owner_totp` recorded the gap in its own comment —
-- «anyone with a database dump today can mint valid codes» — and named 19-د as
-- the phase that must revisit `platform_owners.totp_secret` BY NAME. This is
-- that revisit, for that column and for the two beside it:
--
--   platform_owners.totp_secret       the platform owner's second factor
--   platform_staff.totp_secret        every staff member's, ق-143
--   notification_settings.api_key     a merchant's provider credential
--
-- The envelope is AES-256-GCM. pgcrypto cannot produce one: it ships CBC and
-- ECB and has no AEAD mode at all, so there is no honest way to write the
-- re-encryption as SQL. Attempting it in CBC to keep the backfill inside this
-- file would mean shipping unauthenticated ciphertext — an attacker with write
-- access could then flip bits and the application would decrypt the result to
-- something, which looks exactly like an owner mistyping his code. Authenticated
-- encryption is the point of the change; the language the backfill is written in
-- is not.
--
-- So the re-encryption is `phase1-backend/scripts/encrypt-secrets-at-rest.ts`,
-- and `pnpm phase1:db:migrate` runs it immediately after `prisma migrate
-- deploy` — the same command every deploy and every CI job already runs. It is
-- idempotent and re-runnable: a row already carrying an envelope is skipped, so
-- it is also the tool for a later key rotation.
--
-- Between this migration and that script the platform is CORRECT, not broken:
-- `openSecret()` returns a pre-19-د value untouched, so an owner already
-- enrolled keeps signing in with the phone he already has. That legacy path is
-- the same shape as the one `auth/keys.ts` keeps for signatures, and it empties
-- itself the same way — every write re-seals.
--
-- ============================================================================
-- WHY NO CHECK CONSTRAINT PINNING THE ENVELOPE SHAPE
-- ============================================================================
--
-- A `CHECK (totp_secret LIKE 'codiq1.%')` would be the natural way to make the
-- guarantee structural. It is deliberately absent: it would be violated by every
-- existing row for the seconds between this migration and the backfill, so the
-- migration itself could not commit — and a constraint that forces the data to
-- be correct before it can be made correct is a deployment that cannot happen.
--
-- ============================================================================
-- SOFT DELETE (PG-2)
-- ============================================================================
--
-- `platform_staff` carries `deleted_at`. Nothing here reads or writes rows, so
-- the distinction does not arise in this file — but the backfill script re-seals
-- SOFT-DELETED staff rows too, on purpose: a removed staff member's row is still
-- in the dump, and his secret is exactly as readable as a live one until it is
-- sealed. Filtering on `deleted_at IS NULL` there would leave the plaintext that
-- matters most — the accounts nobody is watching any more — untouched.

COMMENT ON COLUMN platform_owners.totp_secret IS
  'Phase 19-د (D-40): AES-256-GCM envelope — codiq1.<kid>.<iv>.<tag>.<ciphertext>, base64url. Read and written ONLY through auth/secret-box.ts; the key is derived from CODIQ_ENCRYPTION_KEY. A value without the codiq1. prefix predates 19-د and is re-sealed by `pnpm secrets:encrypt`.';

COMMENT ON COLUMN platform_staff.totp_secret IS
  'Phase 19-د (D-40): AES-256-GCM envelope, own purpose label — a ciphertext moved from here into platform_owners.totp_secret fails its authentication tag. Read and written ONLY through auth/secret-box.ts.';

COMMENT ON COLUMN notification_settings.api_key IS
  'Phase 19-د (D-40): AES-256-GCM envelope. Read ONLY through notificationApiKey(), written ONLY through setNotificationApiKey() — never by a direct column update.';
