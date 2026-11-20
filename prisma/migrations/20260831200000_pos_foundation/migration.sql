-- الكاشير (ق-132, ق-135) — the counter sale, on the same order book.
--
-- WHY THIS SHAPE. The whole value of the cashier — the thing none of اكد,
-- IQ Soft or ويل offer together — is ONE stock balance under two sales
-- channels. So a POS sale is a StoreOrder (source='pos'), not a parallel
-- system: it inherits returns, reports, order history and store isolation
-- without a line of duplicated logic. What this migration adds is only what a
-- counter sale has and a storefront order does not: a DEVICE, and an
-- idempotency ticket named by that device.
--
-- ============================================================================
-- THE TICKET IS THE IDEMPOTENCY MECHANISM, AND THE DATABASE ENFORCES IT
-- ============================================================================
--
-- The cashier presses "حصّل", the screen hangs, he presses again. The till
-- syncs after an outage and retries a request the server already served. Every
-- one of these is ONE sale that a naive system records twice: two order
-- numbers, two stock decrements, a merchant who stops trusting the numbers.
--
-- The till therefore mints a ticket id for every sale, and
-- UNIQUE (store_id, device_id, ticket_id) makes the replay COLLIDE instead of
-- duplicating. Application code does the friendly half (return the original
-- order with `replayed: true`); the constraint does the load-bearing half.
-- This is a transliteration of checkout_requests (migration 20260818011500),
-- which has carried exactly these semantics for the storefront since 9A —
-- with the customer swapped for a device, because a counter sale has no
-- customer account and store_orders.customer_id is already nullable.
--
-- ============================================================================
-- NO LEDGER ENTRY, BY DECISION (ق-135)
-- ============================================================================
--
-- The finance ledger records money the PLATFORM handles: collected from a
-- courier, owed to a merchant. Cash across a counter never touches the
-- platform — the merchant is already holding it. An entry here, even at zero
-- commission, would make the wallet claim the platform owes money it never
-- took. And both ledger readers treat any type that is not `order_completed`
-- as a SUBTRACTION (see ledger-sign.guard.mjs), so a `pos_sale` entry type
-- would silently subtract in-shop sales from revenue. Reports surface POS
-- sales from store_orders instead, as their own line.

-- ---------------------------------------------------------------- payment method
--
-- store_orders_payment_method_allowed has guarded ('legacy','cod') since 9A.
-- The counter sale pays in CASH ACROSS THE COUNTER, which is not cod: ق-135
-- hangs the no-commission rule off exactly this distinction, and the reports
-- separate «مبيعات المحل» by it. Widened here, additively, rather than by
-- reusing 'cod' and encoding the difference somewhere softer.
ALTER TABLE store_orders DROP CONSTRAINT store_orders_payment_method_allowed;
-- NOT VALID + VALIDATE, the house pattern for CHECKs on store_orders: the
-- exclusive lock is instantaneous and validation scans without blocking
-- writes. The new set is a superset, so validation cannot fail.
ALTER TABLE store_orders ADD CONSTRAINT store_orders_payment_method_allowed
  CHECK (payment_method_code IN ('legacy', 'cod', 'cash')) NOT VALID;
ALTER TABLE store_orders VALIDATE CONSTRAINT store_orders_payment_method_allowed;

-- …and the source constraint, for the same reason. An earlier draft of this
-- file claimed the column had no CHECK — the database corrected that claim
-- the first time a row hit it, which is precisely why these constraints
-- exist. The comment lied; the constraint did not.
ALTER TABLE store_orders DROP CONSTRAINT store_orders_source_allowed;
ALTER TABLE store_orders ADD CONSTRAINT store_orders_source_allowed
  CHECK (source IN ('legacy', 'storefront', 'pos')) NOT VALID;
ALTER TABLE store_orders VALIDATE CONSTRAINT store_orders_source_allowed;


-- ---------------------------------------------------------------- permission overrides
--
-- The overrides CHECK enumerates every grantable code, so a new code must
-- widen it or granting «pos.sell» to one member 500s — pg2's schema guard
-- said exactly this when the first run hit it. Same widening pg2d performed
-- for the trash codes.
ALTER TABLE staff_membership_permission_overrides
  DROP CONSTRAINT staff_membership_permission_overrides_code;
ALTER TABLE staff_membership_permission_overrides
  ADD CONSTRAINT staff_membership_permission_overrides_code CHECK (permission_code IN (
    'catalog.products.view',
    'catalog.products.create',
    'catalog.products.update',
    'catalog.products.delete',
    'catalog.categories.manage',
    'inventory.update',
    'orders.view',
    'orders.update',
    'customers.view',
    'team.manage',
    'settings.manage',
    'catalog.trash.view',
    'catalog.trash.restore',
    'catalog.audit.view',
    'pos.sell'
  ));

-- ---------------------------------------------------------------- devices
--
-- A till the merchant paired: «كاشير ١». The device is the identity that
-- names tickets and rides receipt numbers. `device_short` keeps receipts
-- readable — POS-A7K2-000143 tells the merchant WHICH till sold it.
CREATE TABLE pos_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  label         text NOT NULL,
  device_short  text NOT NULL,
  -- Pairing is revocable, not deletable: a revoked till's past sales keep
  -- their provenance, and «this device was revoked on X» stays a fact.
  revoked_at    timestamptz(6),
  last_seen_at  timestamptz(6),
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_at    timestamptz(6) NOT NULL DEFAULT now(),
  -- The composite target other tables' store-scoped FKs point at — the same
  -- isolation idiom every store-owned table here uses.
  CONSTRAINT pos_devices_id_store_unique    UNIQUE (id, store_id),
  CONSTRAINT pos_devices_store_short_unique UNIQUE (store_id, device_short)
);
CREATE INDEX pos_devices_store_idx ON pos_devices(store_id, created_at DESC);

-- ---------------------------------------------------------------- tickets
CREATE TABLE pos_tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_id           uuid NOT NULL,
  -- Minted ON THE DEVICE at ring-up. This is the fact that survives every
  -- retry, and the only honest identity an offline sale has.
  ticket_id           uuid NOT NULL,
  request_fingerprint text NOT NULL,
  status              text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'succeeded', 'failed')),
  order_id            uuid,
  -- What the device's wall clock claimed. Stored for audit, NEVER written into
  -- the order's created_at: a till clock that is wrong or hostile must not
  -- bend the ledgerless daily totals, the month buckets, or keyset cursors.
  device_reported_at  timestamptz(6) NOT NULL,
  received_at         timestamptz(6) NOT NULL DEFAULT now(),
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT pos_tickets_key_unique UNIQUE (store_id, device_id, ticket_id),
  -- The composite target the shortfall FK points at — without it, nothing in
  -- the DATABASE forces a shortfall row's store to equal its ticket's store.
  CONSTRAINT pos_tickets_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT pos_tickets_device_store_fk
    FOREIGN KEY (device_id, store_id) REFERENCES pos_devices(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT pos_tickets_order_store_fk
    FOREIGN KEY (order_id, store_id) REFERENCES store_orders(id, store_id) ON DELETE RESTRICT
);
CREATE INDEX pos_tickets_lookup_idx ON pos_tickets(store_id, device_id, created_at DESC);

-- ---------------------------------------------------------------- shortfalls
--
-- Two tills sell the last unit while one is offline, or the storefront gets
-- there first. product_variants.stock_quantity carries CHECK (>= 0), so the
-- sync cannot go negative — and REFUSING the sale would be worse: the unit
-- physically left the shop and the merchant was paid; refusing only deletes
-- the record of a real sale and sends him back to a paper notebook. So the
-- decrement clamps at zero and the difference is recorded HERE, loudly, for
-- the merchant to reconcile. An accepted lie about stock, plus a red strip —
-- rather than a rejected truth about a sale.
CREATE TABLE pos_ticket_shortfalls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  pos_ticket_id uuid NOT NULL,
  variant_id    uuid NOT NULL,
  sold_qty      integer NOT NULL CHECK (sold_qty > 0),
  available_qty integer NOT NULL CHECK (available_qty >= 0),
  shortfall_qty integer NOT NULL CHECK (shortfall_qty > 0),
  -- The merchant marks it handled; it is not deleted. «المخزون انحرف يوم كذا
  -- وعولج» stays a fact somebody can look up.
  reviewed_at   timestamptz(6),
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT pos_ticket_shortfalls_ticket_store_fk
    FOREIGN KEY (pos_ticket_id, store_id) REFERENCES pos_tickets(id, store_id) ON DELETE CASCADE,
  CONSTRAINT pos_ticket_shortfalls_variant_store_fk
    FOREIGN KEY (variant_id, store_id) REFERENCES product_variants(id, store_id) ON DELETE RESTRICT
);
CREATE INDEX pos_ticket_shortfalls_open_idx
  ON pos_ticket_shortfalls(store_id) WHERE reviewed_at IS NULL;

COMMENT ON TABLE pos_devices IS
  'ق-132: tills paired to a store. Revocable, never deleted — past sales keep their provenance.';
COMMENT ON TABLE pos_tickets IS
  'ق-132: device-minted idempotency for counter sales. UNIQUE(store,device,ticket) makes a retry return the original order instead of selling twice. No ledger entry is ever written for these — ق-135.';
COMMENT ON TABLE pos_ticket_shortfalls IS
  'ق-132: stock the till sold that the shelf no longer had by sync time. Clamped to zero, recorded loudly, reconciled by the merchant.';
