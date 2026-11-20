-- CODIQ Phase 17 — append-only financial ledger, settlements, per-plan commissions,
-- merchant registration approval, and platform settings (additive-first).
-- The ledger and settlements are database-protected against UPDATE/DELETE with the
-- same trigger pattern that guards order_status_events since phase 8A.

BEGIN;

-- Per-plan platform commission in basis points (ADR-006: indicative, owner-editable).
ALTER TABLE plans ADD COLUMN commission_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plans ADD CONSTRAINT plans_commission_bps CHECK (commission_bps >= 0 AND commission_bps <= 10000);
UPDATE plans SET commission_bps = 300 WHERE code = 'free';
UPDATE plans SET commission_bps = 200 WHERE code = 'growth';
UPDATE plans SET commission_bps = 100 WHERE code = 'pro';

-- Merchant self-registration approval (ADR-006: mode-driven; existing merchants stay approved).
ALTER TABLE merchants ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE merchants ADD CONSTRAINT merchants_approval_status CHECK (approval_status IN ('pending', 'approved', 'rejected'));

-- Platform-level operational settings (key/value; owner-managed).
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO platform_settings (key, value) VALUES ('merchant_self_registration_mode', 'auto');

-- Append-only financial ledger: one entry per completed order, a reversal entry for a
-- return inside the approved window, and owner-authored manual adjustments.
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES store_orders(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL,
  subtotal_iqd INTEGER NOT NULL,
  delivery_fee_iqd INTEGER NOT NULL,
  commission_iqd INTEGER NOT NULL,
  commission_bps INTEGER NOT NULL,
  plan_code TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ledger_entries_type CHECK (entry_type IN ('order_completed', 'order_returned', 'manual_adjustment')),
  CONSTRAINT ledger_entries_bps CHECK (commission_bps >= 0 AND commission_bps <= 10000)
);

CREATE INDEX ledger_entries_store_created_idx ON ledger_entries(store_id, created_at DESC, id);
CREATE INDEX ledger_entries_order_idx ON ledger_entries(order_id);
CREATE INDEX ledger_entries_type_created_idx ON ledger_entries(entry_type, created_at);

CREATE OR REPLACE FUNCTION codiq_prevent_ledger_entry_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CODIQ_LEDGER_ENTRY_IMMUTABLE'
    USING ERRCODE = '23514', DETAIL = 'Ledger entries are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION codiq_prevent_ledger_entry_mutation();

-- Append-only settlement log: the owner marks a merchant period as settled with a
-- totals snapshot computed from the ledger at settlement time.
CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  platform_owner_id UUID NOT NULL REFERENCES platform_owners(id) ON DELETE RESTRICT,
  period_from TIMESTAMPTZ NOT NULL,
  period_to TIMESTAMPTZ NOT NULL,
  orders_count INTEGER NOT NULL,
  subtotal_iqd INTEGER NOT NULL,
  delivery_fee_iqd INTEGER NOT NULL,
  commission_iqd INTEGER NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settlements_period CHECK (period_to > period_from)
);

CREATE INDEX settlements_merchant_created_idx ON settlements(merchant_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION codiq_prevent_settlement_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CODIQ_SETTLEMENT_IMMUTABLE'
    USING ERRCODE = '23514', DETAIL = 'Settlements are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlements_immutable
BEFORE UPDATE OR DELETE ON settlements
FOR EACH ROW EXECUTE FUNCTION codiq_prevent_settlement_mutation();

COMMIT;
