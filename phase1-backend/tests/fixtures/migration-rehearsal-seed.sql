-- ق-247 — production-shaped rows for the migration rehearsal.
--
-- Applied to a database migrated exactly as far as `prisma/migrations/RELEASED`
-- says production is, BEFORE the unreleased migrations replay over it. Every
-- row is a shape production actually holds (read on 2026-09-14, after the
-- release of that day): a merchant with a store, its single payment row — an
-- enabled lowercase 'cod' (ق-209 folded phase 1's upper-case 'COD' and dropped
-- the dead 'CARD'; that older shape is what the rehearsal caught on the day it
-- was born) — a customer with a password and a normalized phone, an order paid
-- 'cod', a platform audit row, a store-less password-reset mail in the outbox,
-- a staff member, a product with one image.
--
-- Columns are the ones that exist at the RELEASED migration. When the marker
-- advances past a migration that renames one of them, this file changes in the
-- same commit — the rehearsal fails loudly otherwise, which is the point.
INSERT INTO merchants (id, email, password_hash, business_name, approval_status, owner_name, phone, phone_normalized)
VALUES ('11111111-1111-4111-8111-111111111111', 'rehearsal-merchant@example.invalid', '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678', 'متجر التمرين', 'approved', 'صاحب التمرين', '07701234567', '+9647701234567');

INSERT INTO stores (id, merchant_id, name, slug, default_subdomain)
VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'متجر التمرين', 'rehearsal-store', 'rehearsal-store');

-- What ق-209 left of phase 1's bootstrap: one enabled 'cod' per store.
INSERT INTO payment_methods (id, store_id, code, display_name, is_enabled, configuration)
VALUES ('33333333-3333-4333-8333-333333333331', '22222222-2222-4222-8222-222222222222', 'cod', 'Cash on Delivery', TRUE, '{}');

INSERT INTO customers (id, store_id, email, password_hash, full_name, phone, phone_normalized)
VALUES ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', 'rehearsal-customer@example.invalid', '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678', 'زبون التمرين', '07701234567', '+9647701234567');

INSERT INTO store_orders (id, store_id, customer_id, order_number, status, payment_method_code, customer_name, total_iqd, subtotal_iqd)
VALUES ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444', 'REH-1001', 'completed', 'cod', 'زبون التمرين', 25000, 25000);

INSERT INTO platform_audit_events (id, entity_type, entity_id, entity_label, action, actor_kind, actor_id, actor_label)
VALUES ('66666666-6666-4666-8666-666666666666', 'merchant', '11111111-1111-4111-8111-111111111111', 'متجر التمرين', 'subscription_assigned', 'platform_owner', '11111111-1111-4111-8111-111111111111', 'المالك');

INSERT INTO notification_outbox (id, store_id, event_type, recipient_kind, channel, recipient, payload, dedupe_key, status)
VALUES ('77777777-7777-4777-8777-777777777777', NULL, 'auth.password_reset', 'account', 'email', 'rehearsal-merchant@example.invalid', '{}', 'reset:rehearsal', 'sent');

INSERT INTO staff (id, email, password_hash, display_name)
VALUES ('88888888-8888-4888-8888-888888888888', 'rehearsal-staff@example.invalid', '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678', 'موظّف التمرين');

INSERT INTO products (id, store_id, sku, name, price_iqd)
VALUES ('99999999-9999-4999-8999-999999999999', '22222222-2222-4222-8222-222222222222', 'REH-SKU-1', 'منتج التمرين', 15000);

INSERT INTO product_images (id, store_id, product_id, object_key, content_type, byte_size, sort_order)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', '99999999-9999-4999-8999-999999999999', 'rehearsal/image.webp', 'image/webp', 1234, 0);
