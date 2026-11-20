-- CD-3 «بوابة إرجاع ذاتية» — the shopper asks; the merchant decides.
--
-- WHAT THIS TABLE IS NOT. It is not a second way to return an order. Moving an
-- order to `returned` reverses money, and there is exactly one path to that:
-- `transitionOrderStatus`, through the state machine, which fires
-- `recordOrderReturn`. This table records the REQUEST and its answer. Approving
-- one calls that same path — it does not write a ledger entry of its own, and it
-- does not set the order's status by hand.
--
-- The reason is not tidiness. A second route to `returned` is a second place the
-- 15-day reversal window has to be checked, a second place the already-reversed
-- guard has to be repeated, and the two would drift.
--
-- THE WINDOW IS THE FINANCE WINDOW, NOT A NEW NUMBER. A shopper may ask while
-- the order can still be reversed automatically (RETURN_REVERSAL_WINDOW_DAYS).
-- Inventing a separate returns window would mean a request that is valid and an
-- approval that silently cannot reverse — `recordOrderReturn` answers
-- «outside_window» and carries on, leaving the merchant charged commission on a
-- sale he refunded, until the platform owner notices and adjusts by hand.
--
-- The request stores the deadline it was created under, so the merchant's screen
-- can say how long he has before approving costs him that manual step.

CREATE TABLE IF NOT EXISTS return_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  order_id       uuid NOT NULL,
  customer_id    uuid NOT NULL,
  status         text NOT NULL DEFAULT 'requested',
  -- The shopper's words. Required: a return with no stated reason gives the
  -- merchant nothing to act on and nothing to learn from.
  reason         text NOT NULL,
  -- The merchant's answer when he refuses. Required with a rejection, for the
  -- same reason hiding a review is: refusing someone needs to be explainable.
  decision_note  text,
  decided_at     timestamptz(6),
  decided_by_kind text,
  decided_by_id  uuid,
  -- The moment automatic reversal stops being possible for this order.
  reversal_deadline timestamptz(6) NOT NULL,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT return_requests_order_fk    FOREIGN KEY (order_id, store_id)    REFERENCES store_orders (id, store_id) ON DELETE CASCADE,
  CONSTRAINT return_requests_customer_fk FOREIGN KEY (customer_id, store_id) REFERENCES customers (id, store_id)    ON DELETE CASCADE,

  CONSTRAINT return_requests_status_ck CHECK (status IN ('requested', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT return_requests_reason_ck CHECK (btrim(reason) <> '' AND length(reason) <= 1000),
  CONSTRAINT return_requests_decision_note_ck CHECK (decision_note IS NULL OR (btrim(decision_note) <> '' AND length(decision_note) <= 1000)),
  -- A rejection must say why. An approval need not.
  CONSTRAINT return_requests_rejection_ck CHECK (status <> 'rejected' OR decision_note IS NOT NULL),
  -- Decided means decided BY someone, AT a moment. Both or neither, and only
  -- for a status that represents a merchant's answer.
  CONSTRAINT return_requests_decided_ck CHECK (
    (status IN ('requested', 'withdrawn') AND decided_at IS NULL AND decided_by_kind IS NULL AND decided_by_id IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_by_kind IS NOT NULL AND decided_by_id IS NOT NULL)
  ),
  CONSTRAINT return_requests_decider_kind_ck CHECK (decided_by_kind IS NULL OR decided_by_kind IN ('merchant', 'staff'))
);

-- ONE OPEN REQUEST PER ORDER. Partial, so a rejected or withdrawn request does
-- not bar the shopper from asking again — a merchant who says «صوّر العيب أولاً»
-- expects a second attempt, and a hard unique index would refuse it.
CREATE UNIQUE INDEX IF NOT EXISTS return_requests_one_open_uq
  ON return_requests (store_id, order_id) WHERE status = 'requested';

-- The merchant's queue: open requests first, oldest first — a return the
-- shopper has been waiting on longest is the one that has cost the most trust.
CREATE INDEX IF NOT EXISTS return_requests_queue_idx
  ON return_requests (store_id, status, created_at ASC, id ASC);

-- The shopper's own list.
CREATE INDEX IF NOT EXISTS return_requests_customer_idx
  ON return_requests (store_id, customer_id, created_at DESC, id DESC);

COMMENT ON TABLE return_requests IS
  'CD-3: a shopper''s return request and its answer. Approving one goes through transitionOrderStatus — this table never writes to the ledger.';

-- ============================================================================
-- AUDIT — answering a shopper's return is an act worth being answerable for.
-- ============================================================================
-- The lists are a UNION of everything already in use (see CD-2's migration):
-- these CHECKs are recreated wholesale, so a later file that named only its own
-- values would outlaw rows an earlier one legitimately wrote.

ALTER TABLE store_audit_events DROP CONSTRAINT IF EXISTS store_audit_events_entity_type;
ALTER TABLE store_audit_events ADD CONSTRAINT store_audit_events_entity_type CHECK (entity_type IN
  ('product','product_variant','product_category','coupon','staff_membership','store_verification','product_review','return_request'));

ALTER TABLE store_audit_events DROP CONSTRAINT IF EXISTS store_audit_events_action;
ALTER TABLE store_audit_events ADD CONSTRAINT store_audit_events_action CHECK (action IN
  ('soft_deleted','restored','purged','purge_blocked',
   'verification.granted','verification.revoked',
   'review.hidden','review.unhidden',
   'return.approved','return.rejected'));
