-- codiq phase 1: identity tables are intentionally separate by design.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE platform_owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_owners_email_normalized CHECK (email = lower(btrim(email)))
);

CREATE TABLE merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  business_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT merchants_email_normalized CHECK (email = lower(btrim(email)))
);

CREATE TABLE stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  custom_domain TEXT UNIQUE,
  default_subdomain TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stores_slug_normalized CHECK (slug = lower(btrim(slug))),
  CONSTRAINT stores_subdomain_normalized CHECK (default_subdomain = lower(btrim(default_subdomain))),
  CONSTRAINT stores_custom_domain_normalized CHECK (custom_domain IS NULL OR custom_domain = lower(btrim(custom_domain)))
);
CREATE INDEX stores_merchant_id_idx ON stores(merchant_id);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customers_store_email_unique UNIQUE (store_id, email),
  CONSTRAINT customers_email_normalized CHECK (email = lower(btrim(email)))
);
CREATE INDEX customers_store_id_idx ON customers(store_id);

CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_methods_store_code_unique UNIQUE (store_id, code),
  CONSTRAINT payment_methods_only_cod_enabled CHECK ((code = 'COD' AND is_enabled = TRUE) OR (code <> 'COD' AND is_enabled = FALSE))
);
CREATE INDEX payment_methods_store_id_idx ON payment_methods(store_id);

CREATE TABLE notification_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
  provider TEXT,
  api_key TEXT,
  sender_id TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE delivery_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  governorate TEXT NOT NULL,
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd >= 0),
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_rates_store_governorate_unique UNIQUE (store_id, governorate),
  CONSTRAINT delivery_rates_iraqi_governorate CHECK (governorate IN (
    'Al Anbar', 'Babylon', 'Baghdad', 'Basra', 'Dhi Qar', 'Diyala', 'Dohuk',
    'Erbil', 'Karbala', 'Kirkuk', 'Maysan', 'Muthanna', 'Najaf', 'Nineveh',
    'Al-Qadisiyyah', 'Saladin', 'Sulaymaniyah', 'Wasit'
  ))
);
CREATE INDEX delivery_rates_store_id_idx ON delivery_rates(store_id);

-- Separate session tables retain type-specific session boundaries as well.
CREATE TABLE platform_owner_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_owner_id UUID NOT NULL REFERENCES platform_owners(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_owner_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX platform_owner_sessions_owner_idx ON platform_owner_sessions(platform_owner_id);

CREATE TABLE merchant_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT merchant_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX merchant_sessions_merchant_idx ON merchant_sessions(merchant_id);

CREATE TABLE customer_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX customer_sessions_customer_idx ON customer_sessions(customer_id);

-- The lock serializes conflicting owner/merchant inserts for the same normalized email.
CREATE OR REPLACE FUNCTION codiq_guard_owner_merchant_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.email, 0));

  IF TG_TABLE_NAME = 'platform_owners' THEN
    IF EXISTS (SELECT 1 FROM merchants WHERE email = NEW.email) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email is already registered as a merchant and cannot be a platform owner';
    END IF;
  ELSIF TG_TABLE_NAME = 'merchants' THEN
    IF EXISTS (SELECT 1 FROM platform_owners WHERE email = NEW.email) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'CODIQ_EMAIL_CONFLICT: this email is already registered as a platform owner and cannot be a merchant';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_owners_guard_owner_merchant_email
BEFORE INSERT OR UPDATE OF email ON platform_owners
FOR EACH ROW EXECUTE FUNCTION codiq_guard_owner_merchant_email();

CREATE TRIGGER merchants_guard_owner_merchant_email
BEFORE INSERT OR UPDATE OF email ON merchants
FOR EACH ROW EXECUTE FUNCTION codiq_guard_owner_merchant_email();

CREATE OR REPLACE FUNCTION codiq_normalize_customer_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  RETURN NEW;
END;
$$;

CREATE TRIGGER customers_normalize_email
BEFORE INSERT OR UPDATE OF email ON customers
FOR EACH ROW EXECUTE FUNCTION codiq_normalize_customer_email();
