/**
 * ق-163 — every field the checkout call ACCEPTS must actually be SENT.
 *
 * ============================================================================
 * THE DEFECT THIS EXISTS TO PREVENT — it was live, and it was silent
 * ============================================================================
 *
 * A shopper redeemed loyalty points. The summary showed the discount. He
 * pressed «تأكيد الطلب» — and the order was created at the full price.
 *
 * The chain had four links and three of them were correct:
 *
 *   1. `StorefrontCheckoutPage.tsx` passed `loyaltyPoints` to the call.
 *   2. `storefront-api.ts` DECLARED `loyaltyPoints` in the parameter type…
 *      …and then built the request body by naming six fields by hand,
 *      `loyaltyPoints` not among them.
 *   3. `storefront.service.ts` read `input.loyaltyPoints` — and got nothing.
 *   4. The order was written without the redemption.
 *
 * WHY NOTHING CAUGHT IT. TypeScript checks that the caller MAY pass the field;
 * it has no opinion about whether the callee then uses it. The server tests
 * posted their own JSON bodies directly, so they exercised a payload the
 * client never sends. Every layer was individually correct and the product was
 * broken — the same shape as ق-160 (the phone) and ق-162 (the governorate).
 *
 * ============================================================================
 * WHY THE GUARD IS SHAPED THIS WAY
 * ============================================================================
 *
 * The trap is a hand-written key list sitting beside a typed parameter — the
 * two are compared by nobody, and the drift is invisible because it is a
 * MISSING line, not a wrong one. Nothing about this is specific to loyalty
 * points: the next optional field added to checkout will be forgotten exactly
 * the same way.
 *
 * So the assertion is structural: read the parameter type, read the body that
 * is actually serialised, and require that every declared field appears in it.
 *
 * Run: pnpm checkout:payload
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../../client/src/lib/storefront-api.ts", import.meta.url)), "utf8");

/** Read a `{ … }` block by brace depth, starting at the `{` at `open`. */
function block(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced braces — the file does not have the shape this guard assumes");
}

// The member is every line from `checkout: (` to the next member at the same indentation —
// one line or many, however a formatter wraps it (review batch 1: it was read as one line).
const lines = source.split(/\r?\n/);
const first = lines.findIndex((line) => /^\s*checkout:\s*\(/.test(line));
assert.ok(first >= 0, "the `checkout` member must exist in storefrontApi — if it was renamed, rename it here too");
const indent = lines[first].match(/^\s*/)[0].length;
// The next member is the next KEY at this indentation — not a closing `) =>` that a
// formatter puts at the same depth.
const nextMember = lines.findIndex(
  (line, index) => index > first && line.match(/^\s*/)[0].length <= indent && /^\s*[A-Za-z_$][\w$]*\s*:/.test(line),
);
const member = lines.slice(first, nextMember < 0 ? undefined : nextMember).join("\n");

// ── what the call SAYS it accepts ────────────────────────────────────────────
const typeStart = member.indexOf("{", member.indexOf("body:"));
const declared = block(member, typeStart)
  .split(";")
  .map((field) => field.trim().match(/^([A-Za-z_]\w*)\??\s*:/)?.[1])
  .filter(Boolean);

assert.ok(declared.length >= 6, `expected the checkout parameter type to declare several fields, read ${declared.length}`);
assert.ok(declared.includes("loyaltyPoints"), "the parameter type must still declare loyaltyPoints — it is the field this guard was born for");

// ── what the call actually SENDS ─────────────────────────────────────────────
const bodyStart = member.indexOf("{", member.indexOf("JSON.stringify("));
const sent = block(member, bodyStart);

// ── they must agree ──────────────────────────────────────────────────────────
// A field may be sent unconditionally (`note: body.note`) or only when set
// (`...(body.note ? { note: body.note } : {})`) — both write `note:` into the
// serialised object, and both are correct. What must never happen is a field
// that appears in the type and nowhere in the body.
const missing = declared.filter((field) => !new RegExp(`\\b${field}\\s*:`).test(sent));

assert.deepEqual(
  missing,
  [],
  `checkout declares ${missing.join(", ")} and never sends ${missing.length === 1 ? "it" : "them"}. ` +
    `A field in the parameter type that is absent from JSON.stringify is invisible to TypeScript and to every ` +
    `server test that posts its own body — the customer sees the effect on screen and the order is written without it.`,
);

console.log(JSON.stringify({
  suite: "checkout-payload",
  status: "passed",
  summary: {
    declared: declared.length,
    fields: declared,
    guarantee: "every field the checkout call accepts is present in the serialised body",
  },
}, null, 2));
