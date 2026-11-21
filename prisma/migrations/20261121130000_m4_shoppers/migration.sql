-- Marketplace M4 — the shopper: one account for the whole market (docs/MARKETPLACE_PLAN.md §1.1, §1.2).
--
-- Until now a customer belonged to ONE store (customers.store_id). A market
-- shopper buys from many, so he is his own identity — the sixth — signing in
-- with his phone and a one-time code. The per-store customer rows stay exactly
-- as they are (store loyalty, returns, reports all keep working); a store's
-- customer row simply points at the shopper it is (customers.shopper_id),
-- created the first time he orders from that store (M5).
--
--   shoppers                  the account: phone, name, email, gender, interests, picture
--   shopper_sessions          like every other identity's session table
--   shopper_otp_challenges    one-time codes, stored only as an HMAC, five tries, five minutes
--   shopper_addresses         delivery addresses with governorate→district, a map point and a verified phone

CREATE TABLE shoppers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_normalized    TEXT NOT NULL UNIQUE,
  full_name           TEXT,
  email               TEXT,
  gender              TEXT,
  interests           INTEGER[] NOT NULL DEFAULT '{}',
  avatar_object_key   TEXT UNIQUE,
  avatar_content_type TEXT,
  avatar_byte_size    INTEGER,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  last_login_at       TIMESTAMPTZ(6),
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT shoppers_phone_iraqi CHECK (phone_normalized ~ '^\+9647[0-9]{9}$'),
  CONSTRAINT shoppers_name_length CHECK (full_name IS NULL OR length(btrim(full_name)) BETWEEN 2 AND 80),
  CONSTRAINT shoppers_email_shape CHECK (email IS NULL OR (length(email) <= 254 AND email LIKE '%_@_%')),
  CONSTRAINT shoppers_gender_known CHECK (gender IS NULL OR gender IN ('male', 'female')),
  CONSTRAINT shoppers_interests_bounded CHECK (cardinality(interests) <= 30),
  CONSTRAINT shoppers_avatar_complete CHECK (
    (avatar_object_key IS NULL AND avatar_content_type IS NULL AND avatar_byte_size IS NULL)
    OR (avatar_object_key IS NOT NULL AND avatar_content_type IS NOT NULL AND avatar_byte_size > 0))
);

CREATE TABLE shopper_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id   UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ(6) NOT NULL,
  revoked_at   TIMESTAMPTZ(6),
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  user_agent   TEXT,
  last_seen_at TIMESTAMPTZ(6)
);
CREATE INDEX shopper_sessions_shopper_idx ON shopper_sessions (shopper_id);

CREATE TABLE shopper_otp_challenges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_normalized TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  -- For «verify this address phone»: the shopper asking. NULL for sign-in.
  shopper_id       UUID REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- HMAC-SHA256(code) under a key derived from the session secret: a leaked row
  -- is not a usable code, and a six-digit code is not brute-forced offline.
  code_hash        TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  expires_at       TIMESTAMPTZ(6) NOT NULL,
  consumed_at      TIMESTAMPTZ(6),
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT shopper_otp_phone_iraqi CHECK (phone_normalized ~ '^\+9647[0-9]{9}$'),
  CONSTRAINT shopper_otp_purpose_known CHECK (purpose IN ('login', 'address_phone')),
  CONSTRAINT shopper_otp_purpose_owner CHECK ((purpose = 'login') = (shopper_id IS NULL)),
  CONSTRAINT shopper_otp_attempts_range CHECK (attempts BETWEEN 0 AND 5)
);
CREATE INDEX shopper_otp_phone_idx ON shopper_otp_challenges (phone_normalized, created_at DESC);

CREATE TABLE shopper_addresses (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id           UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  label                TEXT NOT NULL,
  recipient_name       TEXT NOT NULL,
  phone_normalized     TEXT NOT NULL,
  phone_verified_at    TIMESTAMPTZ(6) NOT NULL,
  alt_phone_normalized TEXT,
  governorate_key      TEXT NOT NULL,
  district_id          INTEGER NOT NULL,
  address_line         TEXT NOT NULL,
  latitude             DOUBLE PRECISION,
  longitude            DOUBLE PRECISION,
  is_default           BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT shopper_addresses_label_length CHECK (length(btrim(label)) BETWEEN 1 AND 40),
  CONSTRAINT shopper_addresses_recipient_length CHECK (length(btrim(recipient_name)) BETWEEN 2 AND 80),
  CONSTRAINT shopper_addresses_phone_iraqi CHECK (phone_normalized ~ '^\+9647[0-9]{9}$'),
  -- The courier's fallback number is a DIFFERENT number, or none.
  CONSTRAINT shopper_addresses_alt_phone CHECK (alt_phone_normalized IS NULL OR (alt_phone_normalized ~ '^\+9647[0-9]{9}$' AND alt_phone_normalized <> phone_normalized)),
  CONSTRAINT shopper_addresses_governorate_known CHECK (codiq_is_governorate_key(governorate_key)),
  CONSTRAINT shopper_addresses_district_in_governorate FOREIGN KEY (district_id, governorate_key) REFERENCES districts (id, governorate_key) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT shopper_addresses_line_length CHECK (length(btrim(address_line)) BETWEEN 5 AND 300),
  CONSTRAINT shopper_addresses_coordinates CHECK ((latitude IS NULL) = (longitude IS NULL) AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)))
);
CREATE INDEX shopper_addresses_shopper_idx ON shopper_addresses (shopper_id, created_at);
-- At most one default address per shopper.
CREATE UNIQUE INDEX shopper_addresses_one_default ON shopper_addresses (shopper_id) WHERE is_default;

-- A store's customer row may be a market shopper. One row per (store, shopper).
ALTER TABLE customers ADD COLUMN shopper_id UUID REFERENCES shoppers(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX customers_store_shopper_key ON customers (store_id, shopper_id) WHERE shopper_id IS NOT NULL;
