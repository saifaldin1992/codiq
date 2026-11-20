-- CODIQ Phase 16 — plans, plan features, merchant subscriptions (additive-first).
-- Seeds the three initial plans (ADR-005) and backfills every existing merchant
-- onto the free plan so entitlement checks are total from the first deploy.
-- No drop/truncate/delete of existing data.

BEGIN;

CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  monthly_price_iqd INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT plans_price CHECK (monthly_price_iqd >= 0)
);

CREATE TABLE plan_features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,
  limit_value INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT plan_features_unique UNIQUE (plan_id, feature_code),
  CONSTRAINT plan_features_code CHECK (feature_code IN (
    'max_stores',
    'max_products',
    'max_staff',
    'max_monthly_orders',
    'max_image_storage_mb'
  )),
  CONSTRAINT plan_features_value CHECK (limit_value >= 0)
);

CREATE INDEX plan_features_plan_idx ON plan_features(plan_id);

CREATE TABLE merchant_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT merchant_subscriptions_status CHECK (status IN ('active', 'cancelled', 'expired'))
);

CREATE UNIQUE INDEX merchant_subscriptions_one_active
  ON merchant_subscriptions(merchant_id) WHERE status = 'active';
CREATE INDEX merchant_subscriptions_merchant_idx ON merchant_subscriptions(merchant_id);
CREATE INDEX merchant_subscriptions_plan_idx ON merchant_subscriptions(plan_id);

-- Initial plans (ADR-005). Prices are indicative and owner-editable at runtime.
INSERT INTO plans (code, name, monthly_price_iqd, sort_order) VALUES
  ('free', 'المجانية', 0, 1),
  ('growth', 'النمو', 25000, 2),
  ('pro', 'الاحتراف', 75000, 3);

INSERT INTO plan_features (plan_id, feature_code, limit_value)
SELECT p.id, f.feature_code, f.limit_value
FROM plans p
JOIN (VALUES
  ('free',   'max_stores',            3),
  ('free',   'max_products',        100),
  ('free',   'max_staff',             2),
  ('free',   'max_monthly_orders',  200),
  ('free',   'max_image_storage_mb', 200),
  ('growth', 'max_stores',            5),
  ('growth', 'max_products',       1000),
  ('growth', 'max_staff',            10),
  ('growth', 'max_monthly_orders', 5000),
  ('growth', 'max_image_storage_mb', 2048),
  ('pro',    'max_stores',           10),
  ('pro',    'max_products',      10000),
  ('pro',    'max_staff',            30),
  ('pro',    'max_monthly_orders', 50000),
  ('pro',    'max_image_storage_mb', 10240)
) AS f(plan_code, feature_code, limit_value) ON f.plan_code = p.code;

-- Backfill: every existing merchant starts on the free plan.
INSERT INTO merchant_subscriptions (merchant_id, plan_id, status)
SELECT m.id, (SELECT id FROM plans WHERE code = 'free'), 'active'
FROM merchants m
WHERE NOT EXISTS (
  SELECT 1 FROM merchant_subscriptions s WHERE s.merchant_id = m.id AND s.status = 'active'
);

COMMIT;
