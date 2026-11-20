-- Phase 30 (first half) — PLAN VERSIONS. Spec: docs/master/03_MASTER_IMPLEMENTATION_ROADMAP.md §30.
--
-- «الخطّة لا تُعدَّل في مكانها؛ الاشتراك يعرف إصداره.» Until now, editing a
-- plan's price, commission or limits changed the terms of every merchant
-- already subscribed to it, the moment the owner pressed save. From here a
-- term change PUBLISHES a new version; existing subscriptions keep the version
-- they subscribed under until renewal (today: until a new subscription row,
-- e.g. the owner re-assigns the plan), and entitlements and commission are read
-- from the subscription's version.
--
-- Subscription STATES (TRIAL/PAST_DUE/GRACE/SUSPENDED…) are the second half of
-- phase 30 and wait on two owner decisions (grace length, what suspension blocks).

CREATE TABLE plan_versions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           UUID        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  version           INTEGER     NOT NULL,
  monthly_price_iqd INTEGER     NOT NULL,
  commission_bps    INTEGER     NOT NULL,
  -- {feature_code: limit}. The same keys as plan_features at the moment of publishing.
  limits            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT plan_versions_version_positive CHECK (version >= 1),
  CONSTRAINT plan_versions_price_nonnegative CHECK (monthly_price_iqd >= 0),
  CONSTRAINT plan_versions_commission_range CHECK (commission_bps BETWEEN 0 AND 10000),
  CONSTRAINT plan_versions_limits_object CHECK (jsonb_typeof(limits) = 'object'),
  CONSTRAINT plan_versions_plan_version_key UNIQUE (plan_id, version),
  -- Target of the composite FK below: a subscription's version must belong to its own plan.
  CONSTRAINT plan_versions_id_plan_key UNIQUE (id, plan_id)
);

-- Published terms do not change. A version nobody subscribes to may still be
-- removed with its plan (CASCADE above); one in use is protected by the
-- subscriptions' RESTRICT foreign key.
CREATE FUNCTION codiq_plan_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plan_versions are immutable: publish a new version instead'
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER plan_versions_immutable BEFORE UPDATE ON plan_versions
  FOR EACH ROW EXECUTE FUNCTION codiq_plan_versions_immutable();

-- Version 1 of every existing plan = its terms today.
INSERT INTO plan_versions (plan_id, version, monthly_price_iqd, commission_bps, limits)
SELECT p.id, 1, p.monthly_price_iqd, p.commission_bps,
       COALESCE((SELECT jsonb_object_agg(f.feature_code, f.limit_value) FROM plan_features f WHERE f.plan_id = p.id), '{}'::jsonb)
  FROM plans p;

ALTER TABLE merchant_subscriptions ADD COLUMN plan_version_id UUID;
UPDATE merchant_subscriptions s
   SET plan_version_id = v.id
  FROM plan_versions v
 WHERE v.plan_id = s.plan_id AND v.version = 1;

-- Every writer gets this for free: a new subscription without a version is
-- pinned to its plan's LATEST version. If the plan has never been versioned
-- (created after this migration and not edited since), version 1 is published
-- from its current terms first — so no code path can create an unversioned
-- subscription, and none had to remember to.
CREATE FUNCTION codiq_subscription_pin_version_row(row_in merchant_subscriptions) RETURNS merchant_subscriptions LANGUAGE plpgsql AS $$
DECLARE
  pinned UUID;
BEGIN
  IF row_in.plan_version_id IS NOT NULL THEN
    RETURN row_in;
  END IF;
  SELECT id INTO pinned FROM plan_versions WHERE plan_id = row_in.plan_id ORDER BY version DESC LIMIT 1;
  IF pinned IS NULL THEN
    INSERT INTO plan_versions (plan_id, version, monthly_price_iqd, commission_bps, limits)
    SELECT p.id, 1, p.monthly_price_iqd, p.commission_bps,
           COALESCE((SELECT jsonb_object_agg(f.feature_code, f.limit_value) FROM plan_features f WHERE f.plan_id = p.id), '{}'::jsonb)
      FROM plans p WHERE p.id = row_in.plan_id
    RETURNING id INTO pinned;
  END IF;
  row_in.plan_version_id := pinned;
  RETURN row_in;
END $$;

CREATE FUNCTION codiq_subscription_pin_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN codiq_subscription_pin_version_row(NEW);
END $$;
CREATE TRIGGER merchant_subscriptions_pin_version BEFORE INSERT ON merchant_subscriptions
  FOR EACH ROW EXECUTE FUNCTION codiq_subscription_pin_version();

-- Moving a row to ANOTHER plan in place re-pins it to that plan's latest
-- version (the old version belongs to the old plan, and the composite FK below
-- would refuse it). An explicit plan_version_id in the same UPDATE wins.
CREATE FUNCTION codiq_subscription_repin_on_plan_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id AND NEW.plan_version_id IS NOT DISTINCT FROM OLD.plan_version_id THEN
    NEW.plan_version_id := NULL;
    RETURN codiq_subscription_pin_version_row(NEW);
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE merchant_subscriptions
  ALTER COLUMN plan_version_id SET NOT NULL,
  ADD CONSTRAINT merchant_subscriptions_plan_version_fkey
    FOREIGN KEY (plan_version_id, plan_id) REFERENCES plan_versions (id, plan_id) ON DELETE RESTRICT;
CREATE INDEX merchant_subscriptions_plan_version_idx ON merchant_subscriptions (plan_version_id);

CREATE TRIGGER merchant_subscriptions_repin_on_plan_change BEFORE UPDATE OF plan_id ON merchant_subscriptions
  FOR EACH ROW EXECUTE FUNCTION codiq_subscription_repin_on_plan_change();
