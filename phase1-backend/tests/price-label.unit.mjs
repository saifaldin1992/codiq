/**
 * Review batch 2, م-٢ — the storefront card shows the price the shopper will PAY.
 *
 * The list's `priceIqd` is the product's stored price; `minPriceIqd`/`maxPriceIqd`
 * are its variants' LIVE prices (an hourly deal lowers them while it runs). A card
 * whose variants all cost the same printed the stored price — 100,000 on the card,
 * 80,000 at checkout during the deal — so the shopper never saw the deal.
 */
import assert from "node:assert/strict";

const { priceLabel, formatIqd } = await import("../../client/src/lib/price-label.ts");
const iqd = (n) => formatIqd.format(n);

// One variant, an hourly deal running: live 80,000, stored 100,000.
assert.equal(priceLabel({ priceIqd: 100_000, minPriceIqd: 80_000, maxPriceIqd: 80_000 }), iqd(80_000), "the deal price, not the stored one");
// Several variants, different live prices: the range, as before.
assert.equal(priceLabel({ priceIqd: 100_000, minPriceIqd: 80_000, maxPriceIqd: 120_000 }), `${iqd(80_000)}–${iqd(120_000)}`);
// No deal: live = stored.
assert.equal(priceLabel({ priceIqd: 50_000, minPriceIqd: 50_000, maxPriceIqd: 50_000 }), iqd(50_000));
// An older payload without live prices: the stored price, as before.
assert.equal(priceLabel({ priceIqd: 50_000 }), iqd(50_000));

console.log(JSON.stringify({ suite: "price-label", status: "passed" }));
