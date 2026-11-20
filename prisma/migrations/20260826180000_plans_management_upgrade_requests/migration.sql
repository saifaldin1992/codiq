-- CODIQ approved addition (2026-08-26) — merchant plan upgrade requests (additive-first).
-- Merchants file upgrade/downgrade requests from the pricing CTA or their
-- subscription panel; the platform owner approves (assigning the subscription)
-- or rejects. Manual approval until phase 25A automates billing.
-- No drop/truncate/delete of existing data.

BEGIN;

CREATE TABLE plan_upgrade_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  requested_plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decided_by UUID REFERENCES platform_owners(id) ON DELETE SET NULL,
  CONSTRAINT plan_upgrade_requests_status CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX plan_upgrade_requests_status_created_idx ON plan_upgrade_requests(status, created_at);
CREATE INDEX plan_upgrade_requests_merchant_idx ON plan_upgrade_requests(merchant_id);
CREATE INDEX plan_upgrade_requests_plan_idx ON plan_upgrade_requests(requested_plan_id);

-- The app-level duplicate check races with itself: one pending request per
-- merchant is enforced structurally, and its P2002 maps to 409 in errors.ts.
CREATE UNIQUE INDEX plan_upgrade_requests_one_pending
  ON plan_upgrade_requests(merchant_id) WHERE status = 'pending';

COMMIT;
