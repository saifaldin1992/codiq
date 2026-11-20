-- Perf seed: a multi-tenant corpus big enough that the planner genuinely
-- prefers a Seq Scan / full Sort when the right composite index is absent.
--
-- One "big" store holds ~half of every store-scoped table, which is the shape
-- that actually hurts in this schema: the tenant partition is large, so an
-- ORDER BY over it is a sort of tens of thousands of rows to return twenty-five.
--
-- CONVENTION: every helper table's `n` equals the generate_series index that
-- produced the row (created_at descends with i, so ORDER BY created_at DESC
-- recovers i exactly). That makes cross-table joins line up by construction
-- instead of by luck.

DROP TABLE IF EXISTS perf_m, perf_s, perf_ae, perf_c, perf_p, perf_v, perf_vs, perf_o;

-- The merchant e-mail guard takes ONE advisory xact lock per row; 60k of them in
-- a single transaction exhausts max_locks_per_transaction. The reserved-slug and
-- immutability guards are likewise per-row. None has anything to do with query
-- plans, so the seed turns them off and back on again.
ALTER TABLE merchants DISABLE TRIGGER merchants_guard_owner_merchant_staff_email;
ALTER TABLE stores DISABLE TRIGGER codiq_guard_reserved_store_slug;
ALTER TABLE store_audit_events DISABLE TRIGGER store_audit_events_immutable;
ALTER TABLE platform_audit_events DISABLE TRIGGER platform_audit_events_immutable;
ALTER TABLE settlements DISABLE TRIGGER settlements_immutable;
ALTER TABLE platform_owners DISABLE TRIGGER platform_owners_guard_owner_merchant_staff_email;

TRUNCATE TABLE order_notes, wishlist_items, cart_items, platform_owners, pos_devices, pos_tickets, merchants, stores, customers, products, product_variants, store_orders,
  wishlist_items, inventory_reservations, pos_ticket_shortfalls, shopping_carts,
  plan_upgrade_requests, notification_outbox, settlements, return_requests,
  store_audit_events, platform_audit_events, coupons CASCADE;

-- ---------------------------------------------------------------- merchants
INSERT INTO merchants (email, password_hash, business_name, approval_status, created_at)
SELECT 'perf' || i || '@codiq.test', 'x', 'تاجر رقم ' || lpad(i::text, 6, '0'),
       CASE WHEN i % 9 = 0 THEN 'pending' ELSE 'approved' END,
       now() - (i || ' seconds')::interval
FROM generate_series(0, 59999) i;

CREATE TABLE perf_m AS SELECT id, (row_number() OVER (ORDER BY created_at DESC)) - 1 AS n FROM merchants;
CREATE INDEX ON perf_m (n);

-- ------------------------------------------------------------------- stores
INSERT INTO stores (merchant_id, name, slug, default_subdomain, created_at)
SELECT m.id, 'متجر ' || i, 'perf-store-' || i, 'perf-store-' || i, now() - (i || ' seconds')::interval
FROM generate_series(0, 59999) i JOIN perf_m m ON m.n = i;

CREATE TABLE perf_s AS SELECT id, (row_number() OVER (ORDER BY created_at DESC)) - 1 AS n FROM stores;
CREATE INDEX ON perf_s (n);

-- The tenant skew: half of every store-scoped row belongs to store n = 0.
CREATE OR REPLACE FUNCTION perf_store_n(i bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN i % 2 = 0 THEN 0 ELSE 1 + (i % 199) END $$;

-- ------------------------------------------------------- store_audit_events
-- Seeded BEFORE products/coupons: PG-2's `*_deleted_pair` check makes a
-- soft-deleted row impossible without the audit event that deleted it.
INSERT INTO store_audit_events (store_id, entity_type, entity_id, entity_label, action, actor_kind, actor_id, actor_label, created_at)
SELECT s.id, (ARRAY['product','coupon','staff_membership','product_category'])[1 + (i % 4)],
       gen_random_uuid(), 'كيان ' || i, 'soft_deleted', 'merchant', gen_random_uuid(), 'التاجر', now() - (i || ' seconds')::interval
FROM generate_series(0, 199999) i JOIN perf_s s ON s.n = perf_store_n(i);

CREATE TABLE perf_ae AS SELECT id, store_id, (row_number() OVER (ORDER BY created_at DESC)) - 1 AS n FROM store_audit_events;
CREATE INDEX ON perf_ae (n);

-- ---------------------------------------------------------------- customers
INSERT INTO customers (store_id, password_hash, full_name, created_at)
SELECT s.id, 'x', 'زبون ' || i, now() - (i || ' seconds')::interval
FROM generate_series(0, 119999) i JOIN perf_s s ON s.n = perf_store_n(i);

CREATE TABLE perf_c AS SELECT id, store_id, (row_number() OVER (ORDER BY created_at DESC)) - 1 AS n FROM customers;
CREATE INDEX ON perf_c (n);

-- ----------------------------------------------------------------- products
-- Every fifth product is in the trash, with the audit event that put it there.
INSERT INTO products (store_id, sku, name, price_iqd, created_at, is_active, deleted_at, deleted_event_id)
SELECT s.id, 'PERF-SKU-' || lpad(i::text, 6, '0'), 'منتج ' || i, 1000 + i,
       now() - (i || ' seconds')::interval, (i % 5 <> 0),
       CASE WHEN i % 5 = 0 THEN now() - (i || ' seconds')::interval END,
       CASE WHEN i % 5 = 0 THEN ae.id END
FROM generate_series(0, 99999) i
JOIN perf_s s ON s.n = perf_store_n(i)
JOIN perf_ae ae ON ae.n = i;

CREATE TABLE perf_p AS SELECT id, store_id, (row_number() OVER (ORDER BY created_at DESC)) - 1 AS n FROM products;
CREATE INDEX ON perf_p (n);
-- One variant per product (the products trigger creates the default), so the
-- product's own n carries over.
CREATE TABLE perf_v AS SELECT v.id, v.store_id, v.product_id, p.n FROM product_variants v JOIN perf_p p ON p.id = v.product_id;
CREATE INDEX ON perf_v (n);
CREATE TABLE perf_vs AS SELECT DISTINCT ON (store_id) id, store_id, product_id FROM perf_v ORDER BY store_id, n;
CREATE INDEX ON perf_vs (store_id);

-- ------------------------------------------------------------- store_orders
INSERT INTO store_orders (store_id, order_number, status, customer_name, total_iqd, customer_id, created_at)
SELECT c.store_id, 'PERF-' || lpad(i::text, 9, '0'),
       (ARRAY['new','processing','preparation','out_for_delivery','completed'])[1 + (i % 5)],
       'زبون ' || i, 5000 + i, c.id, now() - (i || ' seconds')::interval
FROM generate_series(0, 199999) i JOIN perf_c c ON c.n = (i % 120000);

CREATE TABLE perf_o AS SELECT id, store_id, customer_id, (row_number() OVER (ORDER BY created_at DESC)) - 1 AS n FROM store_orders;
CREATE INDEX ON perf_o (n);

-- ---------------------------------------------------------- wishlist_items
-- Many shoppers with a handful of saved items each, plus one enthusiast with
-- five hundred. The defect the list has is scanning EVERY shopper's wishlist on
-- the platform to return one shopper's twenty-five rows.
INSERT INTO wishlist_items (store_id, customer_id, product_id, variant_id, created_at)
SELECT v.store_id, c.id, v.product_id, v.id, now() - (v.n || ' seconds')::interval
FROM perf_v v JOIN perf_c c ON c.n = v.n AND c.store_id = v.store_id
ON CONFLICT DO NOTHING;
INSERT INTO wishlist_items (store_id, customer_id, product_id, variant_id, created_at)
SELECT v.store_id, c.id, v.product_id, v.id, now() - (v.n || ' seconds')::interval
FROM perf_v v JOIN perf_c c ON c.n = 0 AND c.store_id = v.store_id
WHERE v.n < 1000
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------- order_notes
-- Spread over the big store's orders, with one order carrying a long thread.
INSERT INTO order_notes (store_id, order_id, author_kind, author_id, body, created_at)
SELECT o.store_id, o.id, 'merchant', gen_random_uuid(), 'ملاحظة ' || o.n, now() - (o.n || ' seconds')::interval
FROM perf_o o WHERE o.n < 120000;

-- …and 20,000 on ONE order, so the per-order thread has a deep page to walk.
INSERT INTO order_notes (store_id, order_id, author_kind, author_id, body, created_at)
SELECT o.store_id, o.id, 'merchant', gen_random_uuid(), 'خيط طويل ' || i, now() - (i || ' seconds')::interval
FROM generate_series(1, 20000) i CROSS JOIN (SELECT id, store_id FROM perf_o WHERE n = 0) o;

-- --------------------------------------------------- inventory_reservations
INSERT INTO inventory_reservations (store_id, order_id, product_id, variant_id, quantity, status, return_disposition, returned_at, created_at)
SELECT o.store_id, o.id, vs.product_id, vs.id, 1, 'released',
       CASE WHEN o.n % 3 = 0 THEN 'pending_inspection' ELSE 'not_returned' END,
       now() - (o.n || ' seconds')::interval, now() - (o.n || ' seconds')::interval
FROM perf_o o JOIN perf_vs vs ON vs.store_id = o.store_id;

-- ------------------------------------------------------ pos_ticket_shortfalls
-- One till and one ticket per store: the shortfall rows are what the list
-- pages over, and they all hang off the same ticket by design here.
INSERT INTO pos_devices (store_id, label, device_short)
SELECT store_id, 'كاشير', 'PERF' FROM perf_vs;
INSERT INTO pos_tickets (store_id, device_id, ticket_id, request_fingerprint, status, device_reported_at)
SELECT d.store_id, d.id, gen_random_uuid(), 'perf', 'succeeded', now() FROM pos_devices d;

INSERT INTO pos_ticket_shortfalls (store_id, pos_ticket_id, variant_id, sold_qty, available_qty, shortfall_qty, reviewed_at, created_at)
SELECT v.store_id, t.id, v.id, 3, 1, 2,
       CASE WHEN v.n % 4 = 0 THEN now() END, now() - (v.n || ' seconds')::interval
FROM perf_v v JOIN pos_tickets t ON t.store_id = v.store_id;

-- ------------------------------------------------------------ shopping_carts
INSERT INTO shopping_carts (store_id, owner_kind, customer_id, status, last_activity_at, created_at)
SELECT c.store_id, 'customer', c.id, CASE WHEN c.n % 6 = 0 THEN 'converted' ELSE 'active' END,
       now() - ((c.n + 100000) || ' seconds')::interval, now() - (c.n || ' seconds')::interval
FROM perf_c c;

-- ---------------------------------------------------------------- cart_items
-- The abandoned-cart list filters on `items: { some: {} }`, so a cart with no
-- line would never appear and the measurement would be of an empty set.
INSERT INTO cart_items (cart_id, store_id, product_id, variant_id, quantity, price_snapshot_iqd)
SELECT sc.id, sc.store_id, vs.product_id, vs.id, 1, 5000
FROM shopping_carts sc JOIN perf_vs vs ON vs.store_id = sc.store_id;

-- ------------------------------------------------------ plan_upgrade_requests
INSERT INTO plan_upgrade_requests (merchant_id, requested_plan_id, status, created_at)
SELECT m.id, (SELECT id FROM plans WHERE code = 'growth'),
       -- one pending row per merchant at most: `plan_upgrade_requests_one_pending`
       -- is a partial unique index on merchant_id WHERE status = 'pending'.
       CASE WHEN i < 60000 THEN 'pending' WHEN i % 2 = 0 THEN 'approved' ELSE 'rejected' END,
       now() - (i || ' seconds')::interval
FROM generate_series(0, 79999) i JOIN perf_m m ON m.n = (i % 60000);

-- -------------------------------------------------------- notification_outbox
INSERT INTO notification_outbox (store_id, event_type, recipient_kind, channel, status, created_at)
SELECT s.id, 'order.created', 'customer', 'email', 'sent', now() - (i || ' seconds')::interval
FROM generate_series(0, 199999) i JOIN perf_s s ON s.n = perf_store_n(i);

-- -------------------------------------------------------------- settlements
-- Concentrated on 300 merchants: a settlement history is per-merchant, and the
-- merchant with four hundred of them is the one the list has to serve fast.
INSERT INTO platform_owners (email, password_hash, display_name)
VALUES ('perf-owner@codiq.test', 'x', 'المالك');

-- `settlements_no_overlap` is a GiST exclusion on (merchant_id, [from,to)), so
-- each merchant's 400 settlements get 400 disjoint one-day windows.
INSERT INTO settlements (merchant_id, platform_owner_id, period_from, period_to, orders_count, subtotal_iqd, delivery_fee_iqd, commission_iqd, created_at)
SELECT m.id, (SELECT id FROM platform_owners LIMIT 1),
       now() - (((i / 300) + 1) || ' days')::interval,
       now() - ((i / 300) || ' days')::interval,
       10, 100000, 5000, 2500, now() - (i || ' seconds')::interval
FROM generate_series(0, 119999) i JOIN perf_m m ON m.n = (i % 300);

-- ---------------------------------------------------------- return_requests
INSERT INTO return_requests (store_id, order_id, customer_id, status, reason, reversal_deadline, created_at)
SELECT o.store_id, o.id, o.customer_id,
       (ARRAY['requested','withdrawn'])[1 + (o.n % 2)],
       'سبب الإرجاع ' || o.n, now() + interval '30 days', now() - (o.n || ' seconds')::interval
FROM perf_o o WHERE o.n < 150000;

-- ------------------------------------------------------ platform_audit_events
INSERT INTO platform_audit_events (entity_type, entity_label, action, actor_kind, actor_id, actor_label, created_at)
SELECT 'merchant', 'تاجر ' || i, 'registration_decided', 'platform_owner', gen_random_uuid(), 'المالك',
       now() - (i || ' seconds')::interval
FROM generate_series(0, 149999) i;

-- ------------------------------------------------------------------ coupons
INSERT INTO coupons (store_id, code, code_normalized, kind, percent_off, created_at, is_active, deleted_at, deleted_event_id)
SELECT s.id, 'PERF' || i, 'perf' || i, 'percent', 10, now() - (i || ' seconds')::interval,
       (i % 4 <> 0),
       CASE WHEN i % 4 = 0 THEN now() - (i || ' seconds')::interval END,
       CASE WHEN i % 4 = 0 THEN ae.id END
FROM generate_series(0, 99999) i
JOIN perf_s s ON s.n = perf_store_n(i)
JOIN perf_ae ae ON ae.n = 100000 + i;

ALTER TABLE merchants ENABLE TRIGGER merchants_guard_owner_merchant_staff_email;
ALTER TABLE stores ENABLE TRIGGER codiq_guard_reserved_store_slug;
ALTER TABLE store_audit_events ENABLE TRIGGER store_audit_events_immutable;
ALTER TABLE platform_audit_events ENABLE TRIGGER platform_audit_events_immutable;
ALTER TABLE settlements ENABLE TRIGGER settlements_immutable;
ALTER TABLE platform_owners ENABLE TRIGGER platform_owners_guard_owner_merchant_staff_email;

VACUUM (ANALYZE);

SELECT 'merchants' t, count(*) FROM merchants
UNION ALL SELECT 'stores', count(*) FROM stores
UNION ALL SELECT 'customers', count(*) FROM customers
UNION ALL SELECT 'products', count(*) FROM products
UNION ALL SELECT 'product_variants', count(*) FROM product_variants
UNION ALL SELECT 'store_orders', count(*) FROM store_orders
UNION ALL SELECT 'inventory_reservations', count(*) FROM inventory_reservations
UNION ALL SELECT 'pos_ticket_shortfalls', count(*) FROM pos_ticket_shortfalls
UNION ALL SELECT 'shopping_carts', count(*) FROM shopping_carts
UNION ALL SELECT 'cart_items', count(*) FROM cart_items
UNION ALL SELECT 'plan_upgrade_requests', count(*) FROM plan_upgrade_requests
UNION ALL SELECT 'notification_outbox', count(*) FROM notification_outbox
UNION ALL SELECT 'settlements', count(*) FROM settlements
UNION ALL SELECT 'return_requests', count(*) FROM return_requests
UNION ALL SELECT 'store_audit_events', count(*) FROM store_audit_events
UNION ALL SELECT 'platform_audit_events', count(*) FROM platform_audit_events
UNION ALL SELECT 'coupons', count(*) FROM coupons;
