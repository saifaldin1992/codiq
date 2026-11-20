-- ق-201 — buying without an account.
--
-- The owner's instruction: registration is OPTIONAL. Until now every checkout
-- required a customer session, and the cart page sent a stranger to a login
-- form before he could pay cash at his own door.
--
-- THE SHAPE: a guest is a CUSTOMER ROW WITHOUT A PASSWORD, not an order without
-- a customer. `store_orders.customer_id` is nullable and could have carried a
-- customer-less order, but everything around checkout — the idempotency key,
-- the cart, the saved address, the coupon lock, the order history, the
-- merchant's directory — is keyed on a customer id, and the checkout
-- transaction is the most tested path on the platform. A shadow row keyed on
-- the phone number reuses all of it unchanged: the second guest order from the
-- same phone lands on the same row, the merchant sees one person, and when the
-- shopper later chooses a password the row simply becomes his account with
-- every order already in it. This is also how the reference platforms do it.
--
-- `is_guest` is the ONE fact the shape adds, and the CHECK is the ONE rule: a
-- row is either a guest or it has a password — never a full account with no
-- way to sign in.
ALTER TABLE customers ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE customers ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customers ADD CONSTRAINT customers_guest_or_password CHECK (is_guest OR password_hash IS NOT NULL);
