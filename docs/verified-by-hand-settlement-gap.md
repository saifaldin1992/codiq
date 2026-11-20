# Verified by hand — the settlement gap (phases 16-20 audit, findings 04/05/06/09)

Four finder agents reported variants of this; I traced it in the code rather than trusting them.

## The mechanism, in three reads

1. **`settlementPeriod` clamps the end to `now`** (`finance.service.ts:171-176`):
   ```ts
   const to = requested > now ? now : requested;
   ```
   The settle form sends «حتى اليوم» as `T23:59:59Z`, so on any working afternoon the
   stored `period_to` is *the moment the operator clicked*, e.g. `14:03`.

2. **The next settlement may not start before that instant** (`:330`):
   ```ts
   if (previous && from < previous.periodTo) throw … SETTLEMENT_PERIOD_OVERLAP
   ```
   The refusal names only the DATE — `previous.periodTo.toISOString().slice(0, 10)` —
   so an operator told «ابدأ من 2026-09-11 أو بعده» picks that date's midnight,
   which is `00:00 < 14:03` and is refused again. The only range the UI lets him
   reach is the NEXT day's midnight.

3. **The wallet's pending window opens at the latest `period_to`**
   (`merchant-wallet.service.ts:85-96`):
   ```ts
   orderBy: [{ periodTo: "desc" }, …]
   const from = lastSettlement?.periodTo ?? null;
   where: { store: { merchantId }, createdAt: { ...(from ? { gt: from } : {}), lte: now } }
   ```

## The consequence

Ledger entries created between `s1.period_to` (14:03) and `s2.period_from`
(next midnight) are:

- **not in s1** — created after its `period_to`;
- **not in s2** — created before its `period_from`;
- **not in pending** — once s2 exists, `from` is s2's `period_to`, which is later
  still, so `createdAt > from` is false for them.

They are in no settlement and on no screen. `settlements_immutable` means s1 can
never be widened to cover them. Roughly ten hours of completed COD orders per
settlement cycle, silently, with the merchant's own «المستحق لك» reading a number
that excludes money he earned.

## Why the existing guard does not catch it

`settlements_no_overlap` (migration `20260904142000_rt_money_settlement_no_overlap`)
is an EXCLUSION constraint: it forbids two periods covering the same instant. It
says nothing about instants covered by NO period. Contiguity is one-sided —
the comment at `:322` even says «The rule is CONTIGUITY», but the code implements
non-overlap only.

## Shape of the fix (for the report, not yet implemented)

The next period should START at the previous `period_to`, not merely at-or-after
it: make `from` default to `previous.periodTo` server-side and refuse a `from`
that is strictly greater, with the same clarity the overlap refusal has. Then
every instant between the first settlement and the last belongs to exactly one
period, and the wallet's `gt: from` window is exactly «since the last one».
A `settlements:guard` proving a gap is impossible belongs beside it.
