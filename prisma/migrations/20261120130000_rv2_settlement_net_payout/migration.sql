-- Audit 17-ب — the platform transferred money it never stated.
--
-- `settlements` stored five components and no total, the owner's confirm form
-- showed no amount at all, and the only sum his screen invited
-- (sales + delivery − commission) overstated the payout by the redeemed
-- loyalty points. The merchant's settlement history printed the commission —
-- the money he LOST — not the money he received.
--
-- A GENERATED column rather than a written one: the formula is exactly
-- `netPayout` in merchant-wallet.service.ts, it cannot drift from the
-- components, it needs no backfill, and `settlements_immutable` (a DML
-- trigger) is untouched. The table is tiny; the rewrite this ADD COLUMN
-- causes is negligible.
ALTER TABLE settlements
  ADD COLUMN net_payout_iqd INTEGER GENERATED ALWAYS AS
    (subtotal_iqd + delivery_fee_iqd - COALESCE(loyalty_discount_iqd, 0) - commission_iqd) STORED;

COMMENT ON COLUMN settlements.net_payout_iqd IS
  'Audit 17-ب: the money transferred to the merchant for this period = subtotal + delivery − loyalty points − commission (same formula as merchantWallet.netPayout).';
