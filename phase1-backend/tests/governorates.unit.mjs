/**
 * ق-162 — one list of governorates, and a shopper who is offered a choice
 * rather than asked to guess.
 *
 * ============================================================================
 * WHAT THIS EXISTS TO PREVENT — measured, on a live deployment
 * ============================================================================
 *
 * The rehearsal placed a real order on staging and got:
 *
 *   422 DELIVERY_UNAVAILABLE_FOR_GOVERNORATE
 *       "Delivery is unavailable for the selected governorate."
 *
 * The chain, all four links verified:
 *
 *   1. `store-bootstrap` seeded every store's rates with ENGLISH keys.
 *   2. `DeliveryRatesManager.tsx` held a private Arabic label map, so the
 *      MERCHANT saw «بغداد» while the stored key stayed `Baghdad`.
 *   3. The SHOPPER typed his governorate into a FREE-TEXT field labelled
 *      «المحافظة» on an Arabic storefront.
 *   4. `deliveryRateForGovernorate` matched that text against the key exactly.
 *
 * So a shopper typed «بغداد», nothing matched, and checkout refused him in
 * English with a full cart and a typed address. **No real customer could place
 * an order on any store** unless he happened to type `Baghdad` letter for
 * letter in a language the shop is not written in.
 *
 * Staging's fifteen existing orders were all written by tests, which used
 * `"Baghdad"` — because the seed used `"Baghdad"`. The tests agreed with the
 * code and both disagreed with the form. Exactly the shape of ق-160, found the
 * same way, four steps later in the same run.
 *
 * Run: pnpm governorates:test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GOVERNORATES, GOVERNORATE_KEYS, governorateLabel, toGovernorateKey } from "../src/services/governorates.ts";

const summary = {};

// ============================================================
// 1. Eighteen, each with an Arabic name, no duplicates.
// ============================================================
assert.equal(GOVERNORATES.length, 18, "Iraq has eighteen governorates");
assert.equal(new Set(GOVERNORATE_KEYS).size, 18, "no key appears twice — a duplicate would seed two rates for one place");
assert.equal(new Set(GOVERNORATES.map((g) => g.ar)).size, 18, "no Arabic name appears twice — a shopper must not see one place listed twice");
for (const { key, ar } of GOVERNORATES) {
  assert.ok(/^[A-Za-z -]+$/.test(key), `the stored key stays English — rows depend on it: ${key}`);
  assert.ok(!/[A-Za-z]/.test(ar), `the shopper-facing name is Arabic: ${ar}`);
}
summary.list = "18 governorates, unique keys, unique Arabic names";

// ============================================================
// 2. THE BUG, DIRECTLY: what an Iraqi types must resolve.
// ============================================================
assert.equal(toGovernorateKey("بغداد"), "Baghdad", "the exact input that was refused on staging");
assert.equal(toGovernorateKey("البصرة"), "Basra");
assert.equal(toGovernorateKey("بصرة"), "Basra", "…and without the definite article, which people write as often");
assert.equal(toGovernorateKey("أربيل"), "Erbil");
assert.equal(toGovernorateKey(" بغداد "), "Baghdad", "surrounding space is not a different city");
summary.arabicResolves = "Arabic names, with or without the article, resolve to the stored key";

// ============================================================
// 3. Nothing that used to work stops working.
// ============================================================
// Every saved address, every enabled rate, every row in staging and production
// carries the English key. The mapping must be the identity for those.
for (const key of GOVERNORATE_KEYS) {
  assert.equal(toGovernorateKey(key), key, `the stored key maps to itself: ${key}`);
}
summary.backwardCompatible = "every stored English key resolves to itself — no migration, no row changes meaning";

// ============================================================
// 4. An unknown value is passed back as null, never guessed.
// ============================================================
// The caller turns `null` into «pass the original through», so an address
// written before this existed fails as «this store does not deliver there»
// rather than as «we could not read your address».
assert.equal(toGovernorateKey("Wakanda"), null);
assert.equal(toGovernorateKey(""), null);
assert.equal(toGovernorateKey("   "), null);
assert.equal(toGovernorateKey(null), null);
assert.equal(toGovernorateKey(42), null);
summary.neverGuesses = "an unrecognised value returns null rather than a nearest match";

// ============================================================
// 5. The label a shopper reads.
// ============================================================
assert.equal(governorateLabel("Baghdad"), "بغداد");
assert.equal(governorateLabel("Nowhere"), "Nowhere", "an unknown key is shown as-is rather than blanked — a wrong label is worse than a raw one");
summary.label = "English key in, Arabic name out; unknown keys pass through visibly";

// ============================================================
// 6. THE ASSERTION THAT EARNS ITS PLACE: one list, not two.
// ============================================================
// The defect was born of a second private copy in the client. If a copy comes
// back, this fails — and it fails naming the file, so nobody has to remember
// that the two lists exist.
const clientManager = fileURLToPath(new URL("../../client/src/components/DeliveryRatesManager.tsx", import.meta.url));
const managerSource = readFileSync(clientManager, "utf8");
assert.ok(
  !managerSource.includes("GOVERNORATE_LABELS"),
  "DeliveryRatesManager must not carry its own governorate table again — that private copy is what let the two sides disagree",
);

// THE MIRROR IS COMPARED, NOT TRUSTED. The client cannot import the server
// module (its tsconfig does not reach that tree, and `prisma` would come with
// it), so the list is repeated in `client/src/lib/governorates.ts` — exactly
// the arrangement that caused this defect. The difference is this block: the
// two files are compared key by key and name by name, so a mirror that drifts
// fails the build instead of failing a shopper.
const mirror = await import("../../client/src/lib/governorates.ts");
assert.deepEqual(
  mirror.GOVERNORATES.map((g) => [g.key, g.ar]),
  GOVERNORATES.map((g) => [g.key, g.ar]),
  "the client mirror must match the server list exactly — same keys, same Arabic names, same order",
);
assert.equal(mirror.governorateLabel("Baghdad"), governorateLabel("Baghdad"), "and both sides must label a key identically");
assert.equal(mirror.governorateLabel("Nowhere"), governorateLabel("Nowhere"), "…including an unknown key");

const bootstrap = readFileSync(fileURLToPath(new URL("../src/services/store-bootstrap.service.ts", import.meta.url)), "utf8");
assert.ok(bootstrap.includes("GOVERNORATE_KEYS"), "the seed must read the shared list");
assert.ok(!/const IRAQI_GOVERNORATES\s*=\s*\[/.test(bootstrap), "…and must not keep a private array beside it");
summary.oneList = "the seed reads the shared list; no private copy survives in the merchant screen or the bootstrap";

console.log(JSON.stringify({ suite: "governorates", status: "passed", summary }, null, 2));
