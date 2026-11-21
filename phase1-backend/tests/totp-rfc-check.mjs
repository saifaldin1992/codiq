import { totpForCounter, base32Encode, base32Decode, verifyTotp } from "../src/auth/totp.ts";
import assert from "node:assert/strict";

// RFC 6238 Appendix B — the published SHA-1 vectors. The seed is the ASCII
// string "12345678901234567890", and each row is a UTC instant with its code.
const seed = Buffer.from("12345678901234567890", "utf8");
const vectors = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];
for (const [seconds, expected] of vectors) {
  const counter = Math.floor(seconds / 30);
  const got = totpForCounter(seed, counter, 8);
  assert.equal(got, expected, `RFC 6238 T=${seconds}: expected ${expected}, got ${got}`);
}
console.log("RFC 6238 vectors:", vectors.length, "of", vectors.length, "match");

// base32 round-trip, since the app reads the secret through it
const raw = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
assert.deepEqual(base32Decode(base32Encode(raw)), raw, "base32 round-trips");
console.log("base32 round-trip: ok");

// single-use: the same code is refused once its step has been consumed
const secret32 = base32Encode(seed);
const now = new Date(1111111109 * 1000);
const first = verifyTotp(secret32, totpForCounter(seed, Math.floor(1111111109 / 30)), { now });
assert.equal(first.ok, true, "a fresh code is accepted");
const replay = verifyTotp(secret32, totpForCounter(seed, Math.floor(1111111109 / 30)), {
  now,
  lastUsedStep: first.step,
});
assert.equal(replay.ok, false, "the same code is refused once its step is spent");
console.log("replay refused: ok");
