-- ق-218 — a password somebody else chose is a temporary password, and the
-- platform now knows which ones they are.
--
-- `createManualMerchant` takes a `temporaryPassword` typed by a platform actor.
-- Nothing ever made it temporary: the merchant was handed it over WhatsApp, had
-- no reason to change a password nobody told him was provisional, and the person
-- who typed it kept a working key to a live merchant account — one that reads
-- every shopper's name, phone and delivery address, exports the order list, and
-- edits COD settlement details, with the store's own audit log attributing all of
-- it to the merchant. Platform staff hold no permission code that would otherwise
-- open a merchant dashboard, so this was the one path that granted it. And
-- docs/BACKLOG.md B-09 makes it the LAUNCH path: the first ten merchants are
-- recruited by hand.
--
-- The column is the record of that fact. While it is set, every merchant surface
-- except «change my password» is refused; changing the password clears it, and
-- from that moment the only person who knows the credential is its owner.
--
-- NULL for every existing row on purpose: a merchant who has been working for
-- months must not be locked out by a migration. The debt this closes is the one
-- being created from today onwards, and the ten hand-made accounts that exist
-- are named in the deployment note rather than guessed at by a DEFAULT.
ALTER TABLE merchants
  ADD COLUMN password_set_by_provisioner_at TIMESTAMPTZ;

COMMENT ON COLUMN merchants.password_set_by_provisioner_at IS
  'ق-218: set when a platform actor chose this account''s password; cleared when the merchant sets his own. While set, merchant surfaces are refused with PASSWORD_CHANGE_REQUIRED.';
