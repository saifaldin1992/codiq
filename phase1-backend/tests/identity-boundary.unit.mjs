/**
 * PS-3 — the refusal a person reads about himself must say what he IS, what the
 * area WANTS, and what to do. In Arabic.
 *
 * WHAT THIS EXISTS TO PREVENT, exactly. `IDENTITY_BOUNDARY_DENIED` answered
 * «This session type is not allowed in this area.» from the day it shipped:
 * English, on an Arabic-first platform, naming neither side. The owner met it on
 * his own security page on the live platform, and there was no way — from the
 * screen, from the message, or from any log — to learn that signing into a
 * merchant account minutes earlier had overwritten the ONE cookie both
 * identities share (`codiq_session`), and that his owner session was still
 * perfectly alive in the database.
 *
 * Three throw sites produce this code, in three different layers. The assertion
 * that earns its place is the LAST one: that the English sentence is gone from
 * all of them. A message improved in one layer and left in the other two is the
 * shape this defect would take on its way back.
 *
 * Run: pnpm identity:boundary
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDENTITY_LABELS, identityBoundaryMessage } from "../src/auth/redirects.ts";

// Marketplace M4 added the market's shopper (one account across every store).
const KINDS = ["platform_owner", "platform_staff", "merchant", "staff", "customer", "shopper"];

for (const kind of KINDS) {
  assert.ok(IDENTITY_LABELS[kind], `every identity kind is named: ${kind}`);
  assert.ok(!/[A-Za-z_]/.test(IDENTITY_LABELS[kind]), `the label is Arabic, not the internal key: ${kind} -> ${IDENTITY_LABELS[kind]}`);
}
assert.equal(Object.keys(IDENTITY_LABELS).length, KINDS.length, "no identity kind is missing a label, and none is invented");

// The case the owner actually hit: a merchant cookie at the owner's door.
const message = identityBoundaryMessage("merchant", IDENTITY_LABELS.platform_owner);
assert.ok(message.includes("تاجر"), "it says what he is signed in as");
assert.ok(message.includes("مالك المنصة"), "it says what this area wants");
assert.ok(message.includes("سجّل الخروج"), "it says what to do");
assert.ok(message.includes("خفيّ"), "…and how to keep both sessions at once, which is the honest workaround while one cookie serves four identities");
assert.ok(!/[A-Za-z]/.test(message.replace(/[\u200E\u200F\u2068\u2069]/g, "")), `Arabic only — ق-96: ${message}`);

// Every kind produces a distinct, non-empty sentence — no fallthrough to undefined.
const seen = new Set();
for (const kind of KINDS) {
  const text = identityBoundaryMessage(kind, "مالك المنصة");
  assert.ok(text.length > 40 && !text.includes("undefined"), `a real sentence for ${kind}`);
  seen.add(text);
}
assert.equal(seen.size, KINDS.length, "each kind reads differently — otherwise it names nobody");

// THE ASSERTION THAT EARNS ITS PLACE: the dead English sentence is gone from
// every layer, not just the one that was noticed.
const SRC = fileURLToPath(new URL("../src", import.meta.url));
function sources(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sources(full));
    else if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}
/**
 * `openapi.document.ts` is GENERATED from the routing table — it carries every
 * error code as data, not as a throw, and it is regenerated rather than edited.
 * Policing it would report the mirror instead of the thing.
 */
const GENERATED = path.join("http", "openapi.document.ts");
const handWritten = sources(SRC).filter((file) => !file.endsWith(GENERATED));

/**
 * `redirects.ts` OWNS the replacement, and its comment quotes the sentence it
 * replaced — deleting the quotation would delete the reason. Exactly the
 * exemption `ui-conventions.guard.mjs` grants the component that owns the
 * attribute it polices.
 */
const OWNS_THE_MESSAGE = path.join("auth", "redirects.ts");
const offenders = handWritten.filter((file) =>
  !file.endsWith(OWNS_THE_MESSAGE) && readFileSync(file, "utf8").includes("not allowed in this area"),
);
assert.deepEqual(offenders, [], `the English dead end survives in: ${offenders.join(", ")}`);

const throwSites = handWritten.filter((file) => readFileSync(file, "utf8").includes('"IDENTITY_BOUNDARY_DENIED"'));
assert.ok(throwSites.length >= 3, `all three layers still throw this code — found ${throwSites.length}`);
for (const file of throwSites) {
  assert.ok(
    readFileSync(file, "utf8").includes("identityBoundaryMessage("),
    `${path.relative(SRC, file)} throws IDENTITY_BOUNDARY_DENIED without the shared message — that is how one layer drifts`,
  );
}

console.log(JSON.stringify({
  suite: "identity-boundary",
  status: "passed",
  summary: { kinds: KINDS.length, throwSites: throwSites.length, englishDeadEnds: 0, example: message },
}, null, 2));
