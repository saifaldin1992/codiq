/**
 * PS-2 — the enrolment QR must encode what the SERVER minted, and must not run
 * out of room.
 *
 * The owner asked for a scannable code: «هل تستطيع جعله باركود يقرئه البرنامج
 * الخاص بالمصادقه مباشرة». Two things about that can break silently, and this
 * is where both are caught.
 *
 * 1. CAPACITY. `qrcode` THROWS when the payload exceeds the version/EC capacity
 *    it can fit. The otpauth URI grows with the account address, so a long
 *    owner email is the case that would find it — in production, on the screen a
 *    man uses once, with no second chance to notice. Encoded here at the exact
 *    options the card passes, for an address far longer than the owner's.
 *
 * 2. AGREEMENT. The card must draw the QR from `material.uri` — the string the
 *    server returned — and never re-derive an otpauth URI of its own from the
 *    secret. If it re-derived one, a future change to issuer, digits or period
 *    on the server would leave the image and the key underneath it describing
 *    two different accounts, and the failure would look like «the code is
 *    wrong» rather than like a bug. Asserted by reading the component.
 *
 * What this canNOT prove is that a phone camera reads the image. That is why
 * the card keeps the key and the link on screen beside the QR — the fallback is
 * the real guarantee, and this test guards the convenience.
 *
 * Run: pnpm totp:qr
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toDataURL } from "qrcode";
import { generateTotpSecret, totpEnrolmentUri } from "../src/auth/totp.ts";

/** Exactly what client/src/components/OwnerAccountPanels.tsx passes. */
const CARD_OPTIONS = { errorCorrectionLevel: "M", margin: 2, width: 232 };

const CARD = fileURLToPath(new URL("../../client/src/components/OwnerAccountPanels.tsx", import.meta.url));

const accounts = [
  "codiqos.iq@gmail.com",
  // Deliberately longer than any address the owner is likely to hold, so the
  // capacity ceiling is hit HERE and not on his screen.
  "a-very-long-platform-owner-address-for-capacity@an-unusually-long-domain-name.example.com",
];

const sizes = [];
for (const account of accounts) {
  const uri = totpEnrolmentUri(generateTotpSecret(), account);
  assert.match(uri, /^otpauth:\/\/totp\//, "the server still mints an otpauth URI");
  const png = await toDataURL(uri, CARD_OPTIONS);
  assert.ok(png.startsWith("data:image/png;base64,"), `a PNG data URI for a ${account.length}-char account`);
  assert.ok(png.length > 1000, "a real image, not an empty canvas");
  sizes.push({ account: account.length, uri: uri.length, png: png.length });
}

const source = readFileSync(CARD, "utf8");
assert.ok(
  /toDataURL\(\s*material\.uri\b/.test(source),
  "the card must encode the SERVER's uri — re-deriving one here would let the image and the key below it describe different accounts",
);
assert.ok(
  source.includes('await import("qrcode")'),
  "the encoder must stay dynamically imported, so it costs nothing until enrolment begins",
);
assert.ok(
  /data-testid="owner-totp-secret"/.test(source) && /owner-totp-copy-uri/.test(source),
  "the key and the link must stay on screen beside the QR — they are the fallback when a camera will not read it",
);

console.log(JSON.stringify({ suite: "totp-qr", status: "passed", summary: { encoded: sizes, options: CARD_OPTIONS } }, null, 2));
