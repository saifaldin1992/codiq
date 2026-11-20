-- 19-د (ATTACK-SURFACE) — platform hostname takeover by store-slug squatting.
--
-- `store_for_host` resolves a visitor's hostname by its FIRST LABEL against
-- `stores.default_subdomain`, and a store's slug is copied into that column
-- verbatim at creation. With the wildcard `*.codiq.iq` documented in
-- docs/DEPLOYMENT.md, a stranger who registered the slug `www` owned
-- `www.codiq.iq`; `codiq` took the apex, whose first label is `codiq` too. The
-- squat also BURNED the name — the slug is unique, so the platform could never
-- claim that hostname again without surgery here.
--
-- The application refuses these labels in three places now. This is the fourth,
-- and the only one that also covers a RENAME: no application path changes a
-- store's slug today, but SQL always can, and «today» is not a guarantee.
--
-- GRANDFATHERING IS DELIBERATE. The trigger fires on INSERT, and on UPDATE only
-- when the value actually CHANGES. A store that already carries a reserved slug
-- keeps it: renaming a merchant's public address behind his back to correct the
-- platform's own oversight trades one broken promise for another. Such a store
-- simply stops resolving as a hostname (`storeForHost` refuses reserved labels
-- outright), which closes the attack without touching his row — and it is the
-- platform owner's job to find him and talk to him.
CREATE TABLE IF NOT EXISTS reserved_store_slugs (
  slug       text PRIMARY KEY,
  reason     text NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now()
);

-- The three groups, and why each is here, are argued in
-- phase1-backend/src/services/reserved-slugs.ts. That module is the authority
-- the application refuses from; this table is the authority the database
-- refuses from, and `phase17:test` asserts the two say exactly the same thing —
-- a mirror without a guard is a copy that rots.
INSERT INTO reserved_store_slugs (slug, reason) VALUES
  ('www',       'reached by habit'),
  ('codiq',     'the apex label of the platform domain'),
  ('api',       'platform surface'),
  ('app',       'platform surface'),
  ('admin',     'platform surface'),
  ('dashboard', 'platform surface'),
  ('platform',  'platform surface'),
  ('staging',   'platform surface'),
  ('demo',      'platform surface'),
  ('status',    'platform surface'),
  ('support',   'platform surface'),
  ('help',      'platform surface'),
  ('account',   'platform surface'),
  ('accounts',  'platform surface'),
  ('auth',      'platform surface'),
  ('login',     'platform surface'),
  ('register',  'platform surface'),
  ('billing',   'platform surface'),
  ('docs',      'platform surface'),
  ('blog',      'platform surface'),
  ('mail',      'infrastructure hostname'),
  ('smtp',      'infrastructure hostname'),
  ('imap',      'infrastructure hostname'),
  ('webmail',   'infrastructure hostname'),
  ('cdn',       'infrastructure hostname'),
  ('static',    'infrastructure hostname'),
  ('assets',    'infrastructure hostname'),
  ('media',     'infrastructure hostname'),
  ('img',       'infrastructure hostname'),
  ('images',    'infrastructure hostname'),
  ('files',     'infrastructure hostname'),
  ('ftp',       'infrastructure hostname'),
  ('ns',        'infrastructure hostname'),
  ('ns1',       'infrastructure hostname'),
  ('ns2',       'infrastructure hostname'),
  ('mx',        'infrastructure hostname'),
  ('vpn',       'infrastructure hostname'),
  ('test',      'infrastructure hostname'),
  ('dev',       'infrastructure hostname'),
  ('localhost', 'infrastructure hostname')
ON CONFLICT (slug) DO NOTHING;

CREATE OR REPLACE FUNCTION codiq_guard_reserved_store_slug() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.slug IS DISTINCT FROM OLD.slug)
     AND EXISTS (SELECT 1 FROM reserved_store_slugs WHERE slug = lower(NEW.slug)) THEN
    RAISE EXCEPTION 'CODIQ_RESERVED_STORE_SLUG: % is reserved for the platform', NEW.slug USING ERRCODE = '23514';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.default_subdomain IS DISTINCT FROM OLD.default_subdomain)
     AND EXISTS (SELECT 1 FROM reserved_store_slugs WHERE slug = lower(NEW.default_subdomain)) THEN
    RAISE EXCEPTION 'CODIQ_RESERVED_STORE_SLUG: % is reserved for the platform', NEW.default_subdomain USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS codiq_guard_reserved_store_slug ON stores;
CREATE TRIGGER codiq_guard_reserved_store_slug
BEFORE INSERT OR UPDATE OF slug, default_subdomain ON stores
FOR EACH ROW EXECUTE FUNCTION codiq_guard_reserved_store_slug();
