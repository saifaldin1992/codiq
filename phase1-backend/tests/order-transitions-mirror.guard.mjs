/**
 * ق-219 — the order board's transition table is repeated in the browser, and
 * the repetition is COMPARED rather than trusted.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 *
 * `client/src/components/OrderWorkspace.tsx` carries a hand-copied duplicate of
 * the server's `transitions` table and DERIVES its terminal statuses from it.
 * That derived set decides one thing: whether a bulk move demands the
 * «هذه حالة نهائية» confirmation before it runs. The two tables agree today, and
 * `md1.integration.mjs` asserts the shape of the confirmation gate — but nothing
 * asserted that the two tables are the same table.
 *
 * The consequence of drift is specific and expensive: if the server ever gains
 * or loses a terminal state and the mirror lags, a merchant bulk-moves forty COD
 * orders into an irreversible status with one click and no warning. That is the
 * ق-166 defect (a mirrored constant nobody compares) on the one screen where the
 * mistake cannot be undone.
 *
 * This repository already solved this exact problem three times —
 * `loyalty-mirror`, `password-mirror`, `search-mirror`. This is the fourth, on
 * the same pattern: the SERVER stays the authority (`transitionOrderStatus`
 * re-checks every edge inside the transaction), so this guard is not what makes
 * the platform safe. It is what keeps the merchant from being warned — or not
 * warned — by a table that is not the rule.
 *
 * Run: pnpm transitions:mirror
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const read = (file) => readFileSync(fileURLToPath(new URL(file, repoRoot)), "utf8");

const SERVER_FILE = "phase1-backend/src/services/order-lifecycle.service.ts";
const CLIENT_FILE = "client/src/components/OrderWorkspace.tsx";

/**
 * The `transitions` object literal, as a map of status → sorted edges.
 *
 * Deliberately a parser over the SOURCE rather than an import: the client's
 * module cannot be imported here (its tsconfig does not reach this tree, and the
 * component pulls React with it), which is the whole reason the table is
 * repeated in the first place.
 */
function transitionTable(source, file) {
  const start = source.indexOf("const transitions");
  assert.ok(start !== -1, `no \`const transitions\` in ${file} — if it was renamed, rename it here rather than dropping the check`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n};", open);
  assert.ok(open !== -1 && close !== -1, `could not read the transitions literal in ${file}`);
  const body = source.slice(open + 1, close);

  const table = {};
  for (const match of body.matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
    const edges = Array.from(match[2].matchAll(/"([a-z_]+)"/g), (edge) => edge[1]).sort();
    table[match[1]] = edges;
  }
  assert.ok(Object.keys(table).length >= 8, `read ${Object.keys(table).length} statuses from ${file}; the state machine has eight`);
  return table;
}

const server = transitionTable(read(SERVER_FILE), SERVER_FILE);
const client = transitionTable(read(CLIENT_FILE), CLIENT_FILE);

assert.deepEqual(
  client,
  server,
  `جدول انتقالات الطلب في شاشة الطلبات لا يطابق جدول الخادم:\n` +
    `  server (${SERVER_FILE}): ${JSON.stringify(server)}\n` +
    `  client (${CLIENT_FILE}): ${JSON.stringify(client)}\n\n` +
    `The client derives TERMINAL_STATUSES from its copy, and that set decides whether a bulk move demands the ` +
    `irreversible-action confirmation. A merchant moving forty COD orders must not be silently denied that warning ` +
    `because a table drifted. Copy the server's table verbatim.`,
);

// The derived set is what the screen actually uses, so assert it as well rather
// than only the table it comes from.
const terminalOf = (table) => Object.keys(table).filter((status) => table[status].length === 0).sort();
assert.deepEqual(terminalOf(client), terminalOf(server), "the DERIVED terminal set must match, which is the thing the confirmation gate reads");

console.log(JSON.stringify({
  suite: "order-transitions-mirror",
  status: "passed",
  summary: {
    statuses: Object.keys(server).length,
    edges: Object.values(server).reduce((total, edges) => total + edges.length, 0),
    terminal: terminalOf(server),
    guarantee: "the order board's transition table is the server's transition table",
  },
}, null, 2));
