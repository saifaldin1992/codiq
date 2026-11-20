/**
 * PG-2 — the static guard that keeps trashed rows out of merchant surfaces.
 *
 * The plan (§1.ب) buys the merchant surface with a LINT, not a database
 * constraint, and says so out loud: the surface that hurts a SHOPPER is closed
 * structurally by the `*_deleted_implies_inactive` CHECK constraints, while a
 * leak in a merchant list is one extra row its own owner sees. This file is the
 * price of that trade — and it fails the build with a `file:line`, so the trade
 * stays honest.
 *
 * Four rules:
 *  1. every read on the five watched models must mention `deletedAt` / `LIVE` /
 *     `TRASHED`, or carry an ALLOWLIST entry with a WRITTEN REASON;
 *  2. every `$queryRaw` / `$executeRaw` template that reads one of the four
 *     watched tables must mention `deleted_at`;
 *  3. `deletedAt` may be WRITTEN only inside `services/soft-delete/`;
 *  4. a nested relation read (`include` / `_count`) on a watched relation must
 *     carry its own `deletedAt` filter — this is what stops a category from
 *     advertising products that are sitting in the bin.
 *
 * The reason string is mandatory by construction: an allowlist entry is a
 * `[file:function, reason]` pair and an empty reason is itself a violation.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SRC_ROOT = path.resolve(HERE, "..", "..", "src");

const WATCHED_MODELS = ["product", "productVariant", "productCategory", "coupon", "storeStaffMembership"];
const READ_METHODS = ["findMany", "findFirst", "findUnique", "findUniqueOrThrow", "findFirstOrThrow", "count", "aggregate", "groupBy"];
const WATCHED_TABLES = ["products", "product_variants", "coupons", "store_staff_memberships"];
/** Relation property names whose nested read must filter for itself. */
const WATCHED_RELATIONS = ["products", "variants", "children", "coupons", "staffMemberships"];
const FILTER_TOKENS = ["deletedAt", "LIVE", "TRASHED"];
const SOFT_DELETE_DIR = path.join("services", "soft-delete");

export interface Violation { file: string; line: number; rule: number; detail: string }

/**
 * `relative/path.ts:functionName` → why this read is allowed to see trashed rows.
 *
 * Keyed on the FUNCTION, not on a line: a line-based key was invalidated by any
 * edit higher in the same file, and three times in one day that turned an
 * unrelated change into ten loud «leaks» that were only arithmetic. A guard that
 * cries wolf teaches its reader to silence it.
 *
 * Every entry here is a deliberate, argued exception. The storefront block is
 * the accepted cost recorded in plan §6.2: those reads are protected by the
 * `deleted ⇒ is_active = false` CHECK constraints instead of by an explicit
 * filter. If a future requirement ever separates «draft» from «deleted», the
 * obligation is to add `LIVE` to these reads BEFORE relaxing any
 * `*_deleted_implies_inactive` constraint — never the other way round.
 */
export const ALLOWLIST: Record<string, string> = {
  "services/platform-staff.service.ts:removePlatformStaff":
    "removePlatformStaff (19-ب / ق-143) — `platform_staff` is NOT one of the five models PG-2 governs: it has no trash bin, no restore door, no purge job, and no TRASH_ENTITY_TYPES entry, deliberately (a removed platform-staff member is re-created, not un-deleted). Rule 3 exists so a MERCHANT-facing soft delete cannot bypass softDelete() and lose its audit event and retention clock; here the audit event is written in the same transaction by recordPlatformAuditEvent and every read of the table filters `deletedAt: null` through requirePlatformStaff/requireLiveMember. Routing this through services/soft-delete/ would mean minting a trash entity type the owner never asked for.",
  "services/storefront.service.ts:publicCategories":
    "publicCategories — a category is public only when a LIVE ACTIVE product hangs under it, and a trashed category cannot gain one (deletion requires zero live products, and a category is revived with any product restored into it). Structural, plan §6.2.",
  "services/storefront.service.ts:categoryFilterIds":
    "categoryFilterIds — collects ids for a public product filter; a trashed category can only ever match trashed/inactive products, which the isActive filter already excludes. Plan §6.2.",
  "services/storefront.service.ts:publicProducts":
    "publicProducts — guarded by isActive:true plus the products_deleted_implies_inactive CHECK. Plan §6.2 lists this read by name as invariant-protected.",
  "services/storefront.service.ts:publicProduct":
    "publicProduct — same as publicProducts: isActive:true plus the CHECK constraint. Plan §6.2.",
  "services/storefront.service.ts:addCartItem":
    "addCartItem — filters isActive on BOTH the variant and its product, so both CHECK constraints apply. Plan §6.2.",
  "services/storefront.service.ts:mergeGuestCartIntoCustomer":
    "mergeGuestCartIntoCustomer — re-prices a guest line only when variant AND product are active; a trashed one keeps the guest's snapshot price and is refused at checkout. Plan §6.2.",
  "services/storefront.service.ts:reorderIntoCart":
    "reorder — skips any line whose variant or product is inactive, and a trashed one is inactive by CHECK. Plan §6.2.",
  "services/storefront.service.ts:settleStorefrontReservations":
    "settleStorefrontReservations — settles an ACTIVE reservation, which is itself a hard guard against deleting the product; it must keep working even if the row were somehow trashed, or stock would never be decremented.",
  "services/product-catalog.service.ts:categoryAncestorDepth":
    "categoryAncestorDepth — trashed rows MUST count here. codiq_guard_category_cycle walks the same chain in SQL with no deleted_at filter and holds the per-store advisory lock, so the trigger is the authority; when this walk filtered them out, a move the service allowed was refused by Postgres with 23514 and the merchant saw a bare 500. The price is that a trashed branch keeps spending the depth budget until it is purged or restored — accepted deliberately, because teaching the trigger to skip them would let a restore rebuild a live four-level tree.",
  "services/product-catalog.service.ts:categorySubtreeHeight":
    "categorySubtreeHeight — same reason as categoryAncestorDepth: the trigger recursive CTE counts trashed descendants, and the two layers must agree or the service permits what the database then refuses.",
  "services/soft-delete/soft-delete.service.ts:keptForRecordsIds":
    "keptForRecordsIds(product_category) — asks which products still hold products.category_id, and the answer must be EVERY row, live or trashed, because that is exactly what Postgres' RESTRICT will refuse the purge on. Filtering to either half would predict a purge the database is going to refuse, which is the false countdown this prediction exists to remove.",
};

function isWatchedRead(node: ts.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const method = node.expression.name.text;
  if (!READ_METHODS.includes(method)) return null;
  const model = node.expression.expression;
  if (!ts.isPropertyAccessExpression(model)) return null;
  const modelName = model.name.text;
  return WATCHED_MODELS.includes(modelName) ? `${modelName}.${method}` : null;
}

function mentionsFilter(text: string, filteredNames: ReadonlySet<string> = new Set()): boolean {
  if (FILTER_TOKENS.some((token) => text.includes(token))) return true;
  // A read may also hoist its filter into a local const — `const where = { …LIVE }`
  // or a shared `productInclude`. Referencing such a name counts, so factoring a
  // filter out of the call site is not punished as if it had been dropped.
  // ⚠️ The name must appear as a VALUE, not as a property KEY.
  //
  // Without the lookahead this rule was self-defeating: a file containing
  // `const where = { storeId, ...LIVE }` registered «where» as a filtered name,
  // and since EVERY Prisma call writes `where:`, rule 1 was silently disabled for
  // that whole file. Proven by deleting `...LIVE` from a scoped read in
  // product-catalog.service.ts and watching the guard stay green — the exact
  // leak it exists to catch.
  for (const name of Array.from(filteredNames)) if (new RegExp(`\\b${name}\\b(?!\\s*:)`).test(text)) return true;
  return false;
}

/** Local const/let names in this file whose initializer already carries a filter. */
function filteredIdentifiers(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (FILTER_TOKENS.some((token) => node.initializer!.getText(source).includes(token))) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return names;
}

function sourceFiles(): Array<{ relative: string; source: ts.SourceFile }> {
  const files: Array<{ relative: string; source: ts.SourceFile }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const relative = path.relative(SRC_ROOT, full).split(path.sep).join("/");
        files.push({ relative, source: ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.ES2022, true) });
      }
    }
  };
  walk(SRC_ROOT);
  return files;
}

/**
 * Runs the guard. `suppressed` is every ALLOWLIST key that actually silenced a
 * finding, so a key that no longer matches anything can be reported as STALE —
 * an allowlist nobody prunes is how a lint stops meaning anything.
 */
export function runDeletedLeakGuard(): { violations: Violation[]; suppressed: string[] } {
  const violations: Violation[] = [];
  const suppressed = new Set<string>();
  for (const { relative, source } of sourceFiles()) {
    const filteredNames = filteredIdentifiers(source);
    const inSoftDeleteModule = relative.split("/").join(path.sep).includes(SOFT_DELETE_DIR) || relative.startsWith("services/soft-delete/");
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    /**
     * The nearest enclosing named function — which is what an allowlist entry is
     * really about anyway. Keying on a LINE meant any edit higher in the file
     * invalidated every entry below it: three wasted cycles in one day, each
     * announcing ten «leaks» that were only arithmetic. A guard that cries wolf
     * teaches its reader to reach for the shift key instead of the finding.
     */
    const enclosingName = (node: ts.Node): string => {
      for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current.name.getText(source);
        // A variable declaration counts only when it DECLARES the function — a
        // `const rows = await prisma…` is the assignment target of the read, not
        // the thing the allowlist reason is written about.
        if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer
          && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) {
          return current.name.getText(source);
        }
      }
      return "<top-level>";
    };
    const report = (node: ts.Node, rule: number, detail: string) => {
      const line = lineOf(node);
      const key = `${relative}:${enclosingName(node)}`;
      const reason = ALLOWLIST[key];
      if (typeof reason === "string" && reason.trim().length >= 20) { suppressed.add(key); return; }
      if (typeof reason === "string") {
        violations.push({ file: relative, line, rule, detail: "ALLOWLIST entry exists but its reason is empty or too short to be a reason." });
        return;
      }
      violations.push({ file: relative, line, rule, detail });
    };

    const visit = (node: ts.Node) => {
      // ---- rules 1 and 4: Prisma reads on the watched models -------------
      if (ts.isCallExpression(node)) {
        const watched = isWatchedRead(node);
        if (watched) {
          const argumentText = node.arguments.map((argument) => argument.getText(source)).join(" ");
          if (!mentionsFilter(argumentText, filteredNames)) report(node, 1, `${watched} reads without deletedAt/LIVE/TRASHED.`);
          for (const nested of nestedRelationProperties(node)) {
            const valueText = nested.initializer.getText(source);
            if (!mentionsFilter(valueText, filteredNames)) {
              report(nested, 4, `nested relation «${nested.name.getText(source)}» is read without its own deletedAt filter.`);
            }
          }
        }
      }
      // ---- rule 2: raw SQL against the watched tables --------------------
      if (ts.isTaggedTemplateExpression(node) || ts.isCallExpression(node)) {
        const head = ts.isTaggedTemplateExpression(node) ? node.tag.getText(source) : node.expression.getText(source);
        // `Prisma.sql` is checked too, not only `$queryRaw`/`$executeRaw`.
        // PG-6 builds its statements as `Prisma.sql` objects so that EXPLAIN can
        // plan the EXACT text the engine runs instead of a hand-copied
        // lookalike — and a builder handed to `prisma.$queryRaw(statement)`
        // carries no table name at the call site, so rule 2 would have looked
        // straight through it. Every pre-existing `Prisma.sql` in the tree is
        // already inside a `$queryRaw(...)` call whose text this rule reads, so
        // widening the head costs nothing and closes the hole.
        if (/(\$(queryRaw|executeRaw)|Prisma\.sql)/.test(head)) {
          const text = node.getText(source);
          const touches = WATCHED_TABLES.some((table) => new RegExp(`(FROM|JOIN|UPDATE|INTO)\\s+${table}\\b`, "i").test(text));
          if (touches && !text.includes("deleted_at")) report(node, 2, "raw SQL reads a watched table without deleted_at.");
        }
      }
      // ---- rule 3: only services/soft-delete may WRITE deletedAt ---------
      if (!inSoftDeleteModule && ts.isPropertyAssignment(node) && node.name.getText(source) === "deletedAt") {
        // A `where`/filter position is a read; a `data` position is a write.
        if (isInsideDataLiteral(node)) report(node, 3, "deletedAt is written outside services/soft-delete/.");
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  return { violations, suppressed: Array.from(suppressed) };
}

export function findDeletedLeaks(): Violation[] {
  return runDeletedLeakGuard().violations;
}

/** ALLOWLIST keys that silenced nothing — they must be deleted. */
export function staleAllowlistKeys(): string[] {
  const used = new Set(runDeletedLeakGuard().suppressed);
  return Object.keys(ALLOWLIST).filter((key) => !used.has(key));
}

/** `data: { … deletedAt … }` anywhere up the chain means this is a WRITE. */
function isInsideDataLiteral(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name) && current.name.text === "data") return true;
    current = current.parent;
  }
  return false;
}

/** Relation properties (`include`/`select`/`_count`) inside a watched read call. */
function nestedRelationProperties(call: ts.CallExpression): ts.PropertyAssignment[] {
  const found: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && WATCHED_RELATIONS.includes(node.name.text)) {
      // Skip the `where`-side relation filters (`variants: { some: { … } }`
      // used as a PREDICATE); only projections need their own filter.
      if (!isInsideWhere(node, call)) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  for (const argument of call.arguments) visit(argument);
  return found;
}

function isInsideWhere(node: ts.Node, stopAt: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== stopAt) {
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name) && current.name.text === "where") return true;
    current = current.parent;
  }
  return false;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((violation) => `  rule ${violation.rule}  ${violation.file}:${violation.line}  ${violation.detail}`).join("\n");
}
