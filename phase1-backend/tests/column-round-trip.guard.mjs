/**
 * ق-167 — a column that is written must be readable by the person it is about.
 *
 * ============================================================================
 * THE PATTERN, NAMED
 * ============================================================================
 *
 * The reconciliation audit found this shape five times. A column is added,
 * every creation path writes it, a test writes a row and reads it back from the
 * database and passes — and no LIST query selects it, so no screen shows it.
 * The write path is easy to test; the read path has no test that fails when it
 * is absent.
 *
 * `Merchant.ownerName` was the purest case: written by all three creation paths
 * — self-registration, the public request, manual provisioning — and read by
 * nothing in the entire platform. So the owner approved merchants who would
 * sell cash-on-delivery under his brand, holding neither a name nor a number.
 *
 * ============================================================================
 * WHY THE READER IS NAMED
 * ============================================================================
 *
 * The first draft of this guard asked only whether the column appeared in some
 * `select` across the services. **It passed while both list queries were
 * stripped** — because the creation paths select the column to return the row
 * they have just written. That is exactly the defect: written, echoed back to
 * the writer, never read by the person it is about.
 *
 * A guard a real regression walks past is worse than no guard, because it is
 * trusted. So each column names the functions that must read it.
 *
 * ============================================================================
 * A REGISTRY, NOT A SCAN
 * ============================================================================
 *
 * Scanning every column would be noise: many are correctly invisible — a hash
 * must never surface, a normalised key is matched server-side only. So the list
 * is written by hand, and OPEN carries what the audit found and we have not
 * closed, so it is recorded debt rather than a rediscovery in three months.
 *
 * Run: pnpm column:roundtrip
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function sources(directory, extension) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sources(full, extension));
    else if (extension.test(full)) found.push(full);
  }
  return found;
}

/** One function body: from its `export async function` line to the next `export`. */
function functionBody(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  if (start === -1) return null;
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

const clientText = sources(path.join(repoRoot, "client/src"), /\.tsx?$/)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

const READERS = [
  { file: "registration.service.ts", fn: "listRegistrationRequests" },
  { file: "entitlement/merchants.ts", fn: "listMerchantsWithPlans" },
];

/** Closed by ق-167: written, selected by a NAMED reader, and rendered. */
const CLOSED = [
  {
    column: "ownerName",
    why: "اسم من يقف خلف طلب التسجيل — تُوافق عليه ولا تعرفه",
    readers: READERS,
  },
  {
    column: "phoneNormalized",
    rendersAs: "phone",
    why: "رقمٌ يُتّصل به قبل الموافقة وبعدها",
    readers: READERS,
  },
];

/**
 * Found by the same audit, NOT closed:
 *
 *   InventoryMovement     13 writers, one orphan count(), no list route — and
 *                         the delete sheet PROMISES the merchant it is kept,
 *                         which makes the missing door a broken word.
 *   returnInspectionNote  the inspection decision and its write-off reason
 *                         leave every screen the moment they are taken.
 *   Customer.isActive     enforced at the login door; no write path exists
 *                         anywhere to set it.
 *   dailyMessageCaps      live in the worker, absent from the settings view
 *                         and from its update schema.
 *
 * Moving one into CLOSED is what shipping it means.
 */
const OPEN = ["InventoryMovement", "returnInspectionNote", "Customer.isActive", "dailyMessageCaps"];

const broken = [];
for (const { column, rendersAs, why, readers } of CLOSED) {
  for (const { file, fn } of readers) {
    const source = readFileSync(path.join(repoRoot, "phase1-backend/src/services", file), "utf8");
    const body = functionBody(source, fn);
    if (body === null) {
      broken.push({
        column,
        why,
        where: `${file}:${fn}`,
        note: "الدالّة غير موجودة — أُعيدت تسميتها؟",
      });
      continue;
    }
    if (!new RegExp(`\\b${column}:\\s*true`).test(body)) {
      broken.push({ column, why, where: `${file}:${fn}`, note: "لا يختاره" });
    }
  }
  if (!clientText.includes(rendersAs ?? column)) {
    broken.push({ column, why, where: "client/src", note: "لا شاشة تعرضه" });
  }
}

assert.deepEqual(
  broken,
  [],
  `عمودٌ يُكتب ولا يُقرأ:\n` +
    broken.map((b) => `  ${b.column} — ${b.why}\n      ${b.where}: ${b.note}`).join("\n") +
    `\n\nA column selected but never rendered is the same defect one layer along, so both halves are required. ` +
    `If a column genuinely should not surface — a hash, a normalised key matched only server-side — remove it ` +
    `from this registry with a reason rather than weakening the assertion.`
);

console.log(
  JSON.stringify(
    {
      suite: "column-round-trip",
      status: "passed",
      summary: {
        closed: CLOSED.map(
          (entry) => `${entry.column} ← ${entry.readers.map((reader) => reader.fn).join(" + ")}`
        ),
        openDebt: OPEN,
        guarantee: "every registered column is selected by a NAMED list query and reaches a screen",
      },
    },
    null,
    2
  )
);
