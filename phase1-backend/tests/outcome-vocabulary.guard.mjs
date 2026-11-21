/**
 * ق-165 — every reason the worker writes is a reason the merchant can read.
 *
 * ============================================================================
 * THE PATTERN THIS BELONGS TO
 * ============================================================================
 *
 * The audit named it: columns that are WRITTEN and never READ. The write path
 * is easy to test — a test writes a row and reads it back from the database and
 * passes — and the read path has no test that fails when it is absent. So the
 * server grows a precise vocabulary and the screen never learns a word of it.
 *
 * `lastOutcome` was the clearest case. The outbox worker records exactly why a
 * message did not go out: which cap was hit, whether the recipient
 * unsubscribed, whether a provider is configured at all. The client declared
 * the field in its row type and rendered nothing. A merchant whose messages
 * stopped saw «إعادة محاولة» and no reason, for a delay that lasts a day.
 *
 * ============================================================================
 * WHAT THIS ASSERTS
 * ============================================================================
 *
 * Every literal outcome the server can write must be a case the client
 * translates. It fails on the NEXT outcome added to the worker without a
 * matching Arabic sentence — which is the moment the vocabulary would start
 * drifting again, not a day later when a merchant asks why.
 *
 * The reverse direction is deliberately NOT asserted: a translation the server
 * no longer writes is dead prose, not a defect a merchant meets.
 *
 * Run: pnpm outcome:vocabulary
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function sources(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sources(full));
    else if (full.endsWith(".ts")) found.push(full);
  }
  return found;
}

// ── what the server can write ────────────────────────────────────────────────
// Two shapes: a bare literal (`lastOutcome: "recipient_unsubscribed"`) and a
// template carrying the number that was hit (`` `daily_cap_deferred:${cap}` ``).
// The client keys on the part before the colon, so that is what is collected.
const written = new Set();
for (const file of sources(path.join(repoRoot, "phase1-backend/src/notifications"))) {
  const source = readFileSync(file, "utf8");
  // The worker stores its own reason; the provider returns one the worker
  // stores verbatim. Both shapes appear as a bare literal or as a template
  // carrying a number — a cap, an HTTP status, an SMTP code — after a colon,
  // and the client keys on the part before it.
  for (const [, value] of source.matchAll(/(?:last)?[Oo]utcome:\s*"([a-z0-9_]+)"/g))
    written.add(value);
  for (const [, value] of source.matchAll(/(?:last)?[Oo]utcome:\s*`([a-z0-9_]+):/g))
    written.add(value);
}

assert.ok(
  written.size >= 8,
  `expected the worker to carry a real vocabulary, collected ${written.size}`
);
assert.ok(
  written.has("daily_cap_deferred"),
  "the cap outcome must still be collected — it is the one a merchant meets most"
);

// ── what the client can say ──────────────────────────────────────────────────
const centre = readFileSync(
  path.join(repoRoot, "client/src/components/NotificationCenter.tsx"),
  "utf8"
);
const start = centre.indexOf("function outcomeReason(");
assert.notEqual(
  start,
  -1,
  "NotificationCenter must keep `outcomeReason` — if it was renamed, rename it here too"
);
const translator = centre.slice(start, centre.indexOf("\n}\n", start));
const translated = new Set(
  Array.from(translator.matchAll(/case "([a-z0-9_]+)":/g), (match) => match[1])
);

// ── they must agree ──────────────────────────────────────────────────────────
const untranslated = [...written].filter((outcome) => !translated.has(outcome)).sort();

assert.deepEqual(
  untranslated,
  [],
  `الخادم يكتب أسباباً لا تعرفها الواجهة: ${untranslated.join(", ")}\n\n` +
    `Each of these can appear on a merchant's notification row. Without a case in \`outcomeReason\` he sees a status ` +
    `badge and no reason — which for a deferral means a full day of silence he cannot explain. Add the Arabic ` +
    `sentence beside the others, or return null deliberately if the status badge already says everything.`
);

console.log(
  JSON.stringify(
    {
      suite: "outcome-vocabulary",
      status: "passed",
      summary: {
        written: written.size,
        translated: translated.size,
        vocabulary: [...written].sort(),
        guarantee:
          "every outcome the outbox worker records has an Arabic sentence the merchant reads",
      },
    },
    null,
    2
  )
);
