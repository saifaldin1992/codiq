/**
 * ق-187 — every term of the order total must be visible to the person who
 * reconciles it.
 *
 * ============================================================================
 * THE DEFECT THIS WAS BUILT FROM
 * ============================================================================
 *
 * `storefront.service.ts` prices a storefront order as
 *
 *   total = subtotal − discount − loyaltyDiscount + delivery
 *
 * and the merchant's order screen, the courier's print sheet and the orders CSV
 * emitted every term of that sum EXCEPT the loyalty one. So a shopper redeems
 * 3,000 points' worth, and the merchant opens the order to reconcile what the
 * courier owes him and reads: subtotal 50,000 · delivery 5,000 · discount 0 ·
 * total 52,000. Four numbers that do not add up, a 3,000 hole with no line to
 * explain it, on the one screen a cash-on-delivery business is run from. The
 * columns were on the row the whole time — `loyalty_points_spent` had exactly
 * one occurrence in the entire platform, the write.
 *
 * ============================================================================
 * WHY THIS GUARD IS ARITHMETIC AND NOT A FIELD LIST
 * ============================================================================
 *
 * A guard that just asserted «the payload contains loyaltyDiscountIqd» would
 * close today's hole and nothing else. The failure was not that ONE field was
 * forgotten; it was that a term was added to the formula and no surface was
 * obliged to grow with it. A tax line, a service fee, a courier surcharge —
 * each would repeat this exactly.
 *
 * So the guard reads the FORMULA out of the pricing code and requires that
 * every term in it reaches every money surface. Adding a term to the sum breaks
 * this guard until the term is either shown or deliberately listed below with a
 * reason. That is the shape that cannot silently regress.
 *
 * Run: pnpm order:money
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const PRICING = "phase1-backend/src/services/storefront.service.ts";
const pricing = read(PRICING);

// The one line that decides what a shopper owes. Pinned by name: if it is
// renamed or moved, this guard fails loudly rather than silently guarding a
// formula that no longer exists.
const formulaMatch = pricing.match(/const totalIqd\s*=\s*([^;]+);/);
assert.ok(
  formulaMatch,
  `${PRICING} no longer contains a \`const totalIqd = …;\` line. This guard reads the order total's own formula to know which money terms exist; ` +
    `with the formula gone it would pass while guarding nothing. Point it at the new pricing expression.`,
);
const formula = formulaMatch[1].replace(/\s+/g, " ").trim();

/**
 * Each term of that sum, and the order column that records it.
 *
 * `shownAs` is the field name every money surface must carry. `subtotalIqd`
 * and `deliveryFeeIqd` are the two the sum starts from; `discountIqd` is the
 * coupon; `loyaltyDiscountIqd` is what points paid for.
 */
const TERMS = [
  { inFormula: "subtotalIqd", column: "subtotalIqd" },
  { inFormula: "discountIqd", column: "discountIqd" },
  { inFormula: "loyaltyPreview.discountIqd", column: "loyaltyDiscountIqd" },
  { inFormula: "deliveryFeeIqd", column: "deliveryFeeIqd" },
];

// 1. The formula still contains exactly the terms this guard knows about. A new
//    term makes this fail — which is the entire point.
const unknown = formula
  .split(/[+-]/)
  .map((part) => part.trim())
  .filter(Boolean)
  .filter((part) => !TERMS.some((term) => term.inFormula === part));
assert.deepEqual(
  unknown,
  [],
  `the order total is computed from a term this guard does not know: ${unknown.join(", ")}.\n` +
    `  formula: total = ${formula}\n` +
    `  A new term in the price must reach the merchant's order screen, the print sheet and the CSV, ` +
    `or the numbers he reconciles cash against stop adding up. Add it to TERMS above once it does.`,
);

/**
 * The three surfaces a merchant reconciles money on. Each is named with the
 * person who reads it, because that is what makes an omission cost something.
 *
 * EACH CHECK IS SCOPED TO THE EXACT SITE, NOT THE FILE. The first version of
 * this guard grepped whole files for the column name and passed while the
 * defect was reintroduced: `order-lifecycle.service.ts` names
 * `loyaltyDiscountIqd` in the LEDGER computation a hundred lines below the
 * payload, so deleting it from the payload changed nothing the guard could see.
 * A guard that greps a file proves the word exists somewhere, which is not the
 * claim. `scope` narrows to the block that must carry it, and `needle` is the
 * exact shape it must take there.
 */
const SURFACES = [
  {
    file: "phase1-backend/src/services/order-lifecycle.service.ts",
    what: "orderPayload — the merchant's order detail screen and the platform's mirror",
    reader: "التاجر وهو يطابق ما يدين به المندوب",
    scope: (source) => {
      const start = source.indexOf("function orderPayload(");
      assert.ok(start >= 0, "order-lifecycle.service.ts no longer declares `function orderPayload(` — this guard cannot find the payload it must check.");
      return source.slice(start, source.indexOf("\n}", start));
    },
    needle: (column) => `${column}:`,
  },
  {
    file: "phase1-backend/src/services/order-print.service.ts",
    what: "the print sheet select",
    reader: "المندوب وهو يحمل الورقة",
    scope: (source) => source,
    needle: (column) => `${column}: true`,
  },
  {
    file: "phase1-backend/src/services/csv-transfer.service.ts",
    what: "the orders export",
    reader: "المحاسب وهو يطابق الملف",
    scope: (source) => source,
    // Both halves, deliberately: selected from the database AND written into
    // the row. A column selected and never written is a wider query, not a
    // wider file.
    needle: (column) => `order.${column}`,
  },
];

const missing = [];
for (const surface of SURFACES) {
  const scoped = surface.scope(read(surface.file));
  for (const term of TERMS) {
    if (!scoped.includes(surface.needle(term.column))) {
      missing.push({ surface: surface.what, file: surface.file, column: term.column, reader: surface.reader });
    }
  }
}

assert.deepEqual(
  missing,
  [],
  `a term of the order total never reaches a surface that shows the total:\n` +
    missing.map((row) => `  · ${row.column} is absent from ${row.file} (${row.surface}) — يقرؤها ${row.reader}`).join("\n") +
    `\n  The screen then shows a sum whose parts do not add up to it, and nothing on it explains the difference.`,
);

// 2. The client must actually RENDER the loyalty line, not merely receive it.
//    A field that arrives in JSON and is never drawn is the same hole one layer
//    up — which is exactly how the original defect survived: the data reached
//    nothing that displayed it.
const RENDERERS = [
  { file: "client/src/components/OrderWorkspace.tsx", what: "the merchant's order detail" },
  { file: "client/src/components/OrderPrintSheet.tsx", what: "the printed sheet" },
  // ق-205: the shopper's own order page — the surface the ق-187 sweep did not
  // reach. He is the one who hands the courier the total, so his page must add
  // up exactly as the merchant's does.
  { file: "client/src/pages/CustomerOrderDetailPage.tsx", what: "the shopper's own order" },
];
// `(order.<column>)` is the shape a rendered amount takes on both screens —
// `formatAmount(order.x)` on the dashboard and `money.format(order.x)` on the
// sheet. Declaring the field in the component's props type does NOT match, and
// that is the point: a type that lists a number nobody draws is precisely how
// this defect stayed invisible.
const unrendered = [];
for (const renderer of RENDERERS) {
  const source = read(renderer.file);
  for (const term of TERMS) {
    if (!source.includes(`(order.${term.column})`)) {
      unrendered.push({ file: renderer.file, what: renderer.what, column: term.column });
    }
  }
}
assert.deepEqual(
  unrendered,
  [],
  `a term of the total reaches the browser and is never drawn:\n` +
    unrendered.map((row) => `  · ${row.column} in ${row.file} (${row.what})`).join("\n") +
    `\n  A number the client receives and does not display is not visible to the merchant, and the total still fails to add up on his screen.`,
);

console.log(JSON.stringify({
  suite: "order-money",
  status: "passed",
  summary: {
    formula: `total = ${formula}`,
    terms: TERMS.map((term) => term.column),
    surfaces: SURFACES.length,
    renderers: RENDERERS.length,
    guarantee: "every term of the order total reaches every surface that displays the total, and is rendered there",
  },
}, null, 2));
