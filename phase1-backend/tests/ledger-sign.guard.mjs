/**
 * codiq — the ledger's sign rule, and the landmine under it.
 *
 * Two places compute what a store earned, and both do it the same way:
 *
 *     const sign = group.entryType === "order_completed" ? 1 : -1;
 *
 * `merchant-wallet.service.ts` uses it to say what the PLATFORM OWES the
 * merchant. `analytics.service.ts` uses it for his revenue figures.
 *
 * THE RULE IS "ONE TYPE ADDS, EVERYTHING ELSE SUBTRACTS" — an allow-list of
 * exactly one. That is safe today because the only other types are
 * `order_returned` and `manual_adjustment`, and a return genuinely should
 * subtract. It stops being safe the moment anyone adds a fourth type.
 *
 * The failure would be silent and financial. A new `pos_sale` type — the exact
 * thing the cashier work was about to need — would make every in-shop sale
 * SUBTRACT from the merchant's revenue and from his wallet. No error, no
 * exception: just a number that is wrong in the merchant's favour or against
 * it, in the one part of the platform where being wrong is unforgivable.
 *
 * This guard makes that impossible to do quietly. Add a type to the CHECK
 * constraint and this test fails until someone has decided, in writing, which
 * side of the sign it belongs on and updated BOTH readers.
 *
 * It is deliberately a source guard rather than a runtime test: the bug is not
 * that some query returns the wrong number today, it is that the next person to
 * add a type will not know these two lines exist.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

/** The entry types the database itself permits, read from the CHECK constraint. */
function typesFromMigrations() {
  const dir = path.join(root, "prisma", "migrations");
  const found = new Set();
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry, "migration.sql");
    let sql;
    try {
      sql = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // CHECK (entry_type IN ('a', 'b', 'c'))  — and any later ALTER that adds one.
    for (const match of sql.matchAll(/entry_type\s+IN\s*\(([^)]*)\)/gi)) {
      for (const quoted of match[1].match(/'([^']+)'/g) ?? []) found.add(quoted.slice(1, -1));
    }
  }
  return [...found].sort();
}

const KNOWN = ["manual_adjustment", "order_completed", "order_returned"];
const actual = typesFromMigrations();

assert.deepEqual(
  actual,
  KNOWN,
  [
    "A ledger entry type was added or removed, and the sign rule has not been reviewed.",
    "",
    `  expected: ${KNOWN.join(", ")}`,
    `  found:    ${actual.join(", ")}`,
    "",
    "FOUR readers decide money from this list, and ALL treat anything that is not",
    "`order_completed` as a SUBTRACTION:",
    "",
    "  phase1-backend/src/services/merchant-wallet.service.ts   — what the platform OWES",
    "  phase1-backend/src/services/analytics.service.ts         — the merchant's revenue",
    "  phase1-backend/src/services/finance.service.ts           — the finance overview",
    "  phase1-backend/src/services/platform-overview.service.ts — the owner's GMV and commission",
    "",
    "So a new type subtracts by default, silently. Decide which side it belongs on,",
    "update every reader, then add it to KNOWN in this file.",
    "",
    "If the new type represents money the PLATFORM never handled — an in-shop cash",
    "sale, for instance — it probably should not be a ledger entry at all: the",
    "ledger is what the platform owes and collects, and the merchant already holds",
    "that money. Put it in the sales report, not in the wallet.",
  ].join("\n"),
);

// Every reader must still exist and still use the one-type-adds rule. If someone
// rewrites either, this guard's premise is gone and it must be re-derived rather
// than left passing over code it no longer describes.
const readers = [
  "phase1-backend/src/services/merchant-wallet.service.ts",
  "phase1-backend/src/services/analytics.service.ts",
  "phase1-backend/src/services/finance.service.ts",
  // Audit 17-أ: the owner's overview summed every type unsigned until 2026-11.
  // It expresses the rule as two aggregate filters rather than a ternary.
  "phase1-backend/src/services/platform-overview.service.ts",
];
const RULE_SHAPES = [
  (source) => source.includes('entryType === "order_completed" ? 1 : -1'),
  (source) => source.includes('entryType: "order_completed" }') && source.includes('entryType: { not: "order_completed" } }'),
];
for (const reader of readers) {
  const source = readFileSync(path.join(root, reader), "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.ok(
    RULE_SHAPES.some((matches) => matches(source)),
    `${reader} no longer uses the one-type-adds sign rule. This guard describes code that has changed — re-derive it rather than deleting it.`,
  );
}

console.log(
  JSON.stringify(
    {
      ledgerSign: {
        typesPermittedByTheDatabase: actual,
        addsToRevenue: ["order_completed"],
        subtracts: actual.filter((t) => t !== "order_completed"),
        readersGuarded: readers.length,
      },
    },
    null,
    2,
  ),
);
console.log("ledger:sign OK");
