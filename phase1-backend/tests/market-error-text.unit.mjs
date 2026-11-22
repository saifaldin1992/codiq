/**
 * Review batch 2, م-١ — a market shopper reads Arabic, whatever the server wrote.
 *
 * The storefront has always translated an error by its CODE (`errorMessage`); the market
 * showed the server's message as it came, and much of the shared checkout's is English
 * («The cart was changed by another request.»). The market now keeps the server's message
 * when it is Arabic — it is often more precise («المتوفّر من هذا الخيار ٣ فقط») — and
 * otherwise uses the code's Arabic text, or a plain Arabic sentence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { marketErrorText } = await import("../../client/src/market/market-error.ts");
const { ERROR_TEXT } = await import("../../client/src/lib/error-text.ts");

const english = "The cart was changed by another request.";
assert.equal(marketErrorText("CART_VERSION_CONFLICT", english), ERROR_TEXT.CART_VERSION_CONFLICT);
assert.equal(
  marketErrorText("COUPON_EXPIRED", "This coupon is outside its validity window."),
  ERROR_TEXT.COUPON_EXPIRED
);
// The server's Arabic stays: it is the more precise of the two.
assert.equal(
  marketErrorText("INSUFFICIENT_AVAILABLE_STOCK", "المتوفّر من هذا الخيار 3 فقط."),
  "المتوفّر من هذا الخيار 3 فقط."
);
// English with a code the table does not know: never English on the screen.
assert.match(marketErrorText("SOMETHING_NEW", "Order status is not supported."), /[؀-ۿ]/);
assert.match(marketErrorText(null, null), /[؀-ۿ]/);

// Both of the market's fetch helpers go through it.
for (const file of ["client/src/market/market-api.ts", "client/src/market/market-shopper.ts"])
  assert.match(
    readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
    /marketErrorText\(/,
    `${file} must translate its errors`
  );

console.log(JSON.stringify({ suite: "market-error-text", status: "passed" }));
