-- CODIQ 19-أ (PR-1) — «استعادة كلمة السر»: the reset token, and the mail that
-- carries it.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
--
-- Until today a merchant who forgot his password needed a manual UPDATE against
-- production. That is not an inconvenience, it is the platform's only account
-- recovery path, performed by hand, with no audit and no proof that the person
-- asking is the person who owns the account. 19-أ gave every identity a way to
-- CHANGE a password it still knows; this is the other half.
--
-- ============================================================================
-- 1. THE TOKEN TABLE — A HASH, NEVER THE TOKEN
-- ============================================================================
--
-- A reset link is an account takeover primitive: whoever holds it becomes the
-- account. So the row stores `token_hash` (sha256 of 32 random bytes) and the
-- platform never keeps a copy of the value it mailed. A database dump yields
-- nothing that can be replayed — the same reasoning as `*_sessions.token_hash`,
-- which has stored hashes since phase 1.
--
-- sha256 with no salt and no stretch is CORRECT here and would be wrong for a
-- password: the pre-image has 256 bits of entropy drawn from the CSPRNG, so
-- there is no dictionary to run and no cost factor worth paying. Stretching it
-- would only put a bcrypt compare on a public endpoint.
--
-- `subject_id` deliberately carries NO foreign key. It cannot: this platform has
-- FIVE identity kinds in five tables (platform_owner, platform_staff, merchant,
-- staff, customer) and a column cannot reference five parents. `identity_kind`
-- plus `subject_id` is the pair, and the CHECK below pins the kind to the five
-- that exist so a typo cannot invent a sixth.
--
-- `store_id` is the customer's scope and NULL for everyone else, enforced by
-- CHECK: a storefront customer is keyed PER STORE (`customers_store_email_
-- present_uq`), so «this email» is only an identity once you also say «at this
-- store». Without the scope, a reset requested at store A could resolve to the
-- shopper's separate account at store B.

CREATE TABLE password_reset_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_kind    text NOT NULL,
  subject_id       uuid NOT NULL,
  store_id         uuid REFERENCES stores (id) ON DELETE CASCADE,
  -- sha256 hex of the mailed token. UNIQUE so a consume is a single indexed
  -- lookup rather than a scan, and so a collision is a database error rather
  -- than two accounts sharing one link.
  token_hash       text NOT NULL UNIQUE,
  -- A snapshot of where it was sent, for the operator answering «did anything
  -- go out?». Never used to FIND the row — that is what token_hash is for.
  email_normalized text NOT NULL,
  expires_at       timestamptz(6) NOT NULL,
  -- Set the instant the token is spent. The consume is a conditional UPDATE on
  -- this column, so two racing requests cannot both win it.
  consumed_at      timestamptz(6),
  -- Set when the token dies for a reason other than being used: a newer link
  -- was issued, the password changed by another route, or the account's tokens
  -- were cleared as a side effect of a successful reset.
  invalidated_at   timestamptz(6),
  invalidated_reason text,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT password_reset_tokens_identity_kind CHECK (
    identity_kind IN ('platform_owner', 'platform_staff', 'merchant', 'staff', 'customer')
  ),
  -- The scope rule, structural rather than remembered: a customer token is
  -- meaningless without its store, and a dashboard token must not carry one.
  CONSTRAINT password_reset_tokens_store_scope CHECK (
    (identity_kind = 'customer') = (store_id IS NOT NULL)
  ),
  -- A reason is mandatory when a row is invalidated. An invalidation nobody can
  -- explain is an incident nobody can read.
  CONSTRAINT password_reset_tokens_invalidation_reason CHECK (
    (invalidated_at IS NULL) = (invalidated_reason IS NULL)
  )
);

COMMENT ON TABLE password_reset_tokens IS
  '19-أ (PR-1): single-use, short-lived account recovery tokens. Only the sha256 HASH is stored — the platform never holds a copy of a link it mailed.';

-- Serves the two operations that matter: invalidating an identity's outstanding
-- tokens when a newer one is issued or the password changes by another route.
CREATE INDEX password_reset_tokens_live_idx
  ON password_reset_tokens (identity_kind, subject_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

-- ============================================================================
-- 2. THE OUTBOX LEARNS TO CARRY MAIL THAT BELONGS TO NO STORE
-- ============================================================================
--
-- `notification_outbox.store_id` has been NOT NULL since phase 15 because every
-- event until now was about one store's order, stock or cart. A password reset
-- for the PLATFORM OWNER has no store, and there is no honest value to invent:
-- the owner sits above every tenant.
--
-- The column becomes nullable, and a CHECK keeps the loosening from spreading —
-- only the event types named here may go storeless, so the next event type that
-- wants to skip the store boundary has to say so in a migration, exactly as the
-- event_type foreign key already forces every new notification to declare
-- whether it is marketing or operational.
--
-- AND THE SAME RULE IS APPLIED TO EVERY IDENTITY, not only the owner: a
-- merchant's reset mail is attributed to NO store either. Three reasons, all
-- load-bearing:
--
--   · A merchant may own several stores. Picking one to bill the mail against
--     would be arbitrary, and the pick would decide which store's daily cap
--     throttles his ability to get back into his account.
--   · The operational daily caps (PG-3, 19-د) DEFER over-cap mail to tomorrow.
--     A token that expires in 45 minutes cannot survive being deferred to
--     tomorrow; the recipient would receive a dead link. A security mail must
--     not queue behind a merchant's order confirmations. The ceiling for this
--     event lives at the REQUEST door instead — per address and per IP, before
--     a row is ever written — which is the right place for it.
--   · A customer's password reset is not his merchant's business. With no
--     store_id the row never appears in the merchant's notification log, which
--     would otherwise tell him which of his shoppers is recovering an account.

ALTER TABLE notification_outbox ALTER COLUMN store_id DROP NOT NULL;

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_store_scope CHECK (
    store_id IS NOT NULL OR event_type IN ('auth.password_reset')
  );

COMMENT ON COLUMN notification_outbox.store_id IS
  'The store this message belongs to. NULL only for the account-recovery event types named in notification_outbox_store_scope — mail about an identity rather than about a store.';

-- `recipient_kind` has been (merchant, customer) since phase 15, which cannot
-- name an owner, a platform-staff member or a store staff member. Rather than
-- add three values that would then have to be kept in step with the five
-- identity kinds, ONE value is added: the message goes to the person who owns
-- the account, whichever kind of account it is.
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_recipient_kind;
ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_recipient_kind CHECK (recipient_kind IN ('merchant', 'customer', 'account'));

-- ============================================================================
-- 3. THE EVENT TYPE — CLASSIFIED, AND FIRST IN THE QUEUE
-- ============================================================================
--
-- PG-3 replaced the old event_type CHECK with a foreign key into
-- notification_event_kinds precisely so that adding a notification REQUIRES
-- classifying it in the same migration. Adding the value in TypeScript alone
-- typechecks and then fails at runtime with 23514/23503 — the incident this
-- lookup table exists to prevent.
--
-- OPERATIONAL, obviously: it is about something the recipient just did, and no
-- unsubscribe may ever suppress it. A person who muted a store's marketing has
-- said nothing about his own ability to get back into his account.
--
-- PRIORITY -100, ahead of every other operational message (which sit at 0).
-- This is the one event on the platform with an EXPIRING payload: the link dies
-- in 45 minutes, so minutes spent behind a backlog of order confirmations come
-- straight out of the window the recipient has to use it. Nothing else in the
-- queue gets worse by waiting a minute; this does.
INSERT INTO notification_event_kinds (event_type, kind, description, priority) VALUES
  ('auth.password_reset', 'operational', 'رابط استعادة كلمة السر — رسالة أمان لصاحب الحساب نفسه، تسبق كل شيء في الطابور لأن الرابط ينتهي بعد 45 دقيقة.', -100)
ON CONFLICT (event_type) DO NOTHING;
