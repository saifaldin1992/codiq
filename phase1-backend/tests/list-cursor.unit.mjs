/**
 * المرحلة 20-2 — the cursor dialect, proved in isolation.
 *
 * The integration suites prove that page 2 of a real list holds the rows page 1
 * did not. This file proves the properties those suites cannot isolate: that a
 * cursor belonging to ANOTHER list is refused, that a corrupt one is a 400 and
 * never a 500 (the red team found `?cursor=abc` producing a bare
 * INTERNAL_ERROR through an unmapped Prisma P2023 — it must not come back), and
 * that a bare uuid minted before this branch still opens the page it pointed at.
 *
 * Run: pnpm list:unit
 */
import assert from "node:assert/strict";
import { HttpError } from "../src/auth/auth.errors.js";
import {
  decodeListCursor,
  encodeListCursor,
  keysetWhere,
  pageOf,
  parseListLimit,
  readListCursor,
} from "../src/services/list-page.js";

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function refusal(fn) {
  try {
    const result = fn();
    if (result instanceof Promise)
      return result.then(
        () => {
          throw new Error("expected a refusal, got a value");
        },
        (error) => error
      );
    throw new Error("expected a refusal, got a value");
  } catch (error) {
    return error;
  }
}

const ORDER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";

console.log("list cursor — one dialect");

await test("round-trips the ordering value and the row id", () => {
  const at = new Date("2026-09-01T10:00:00.000Z");
  const cursor = encodeListCursor("merchant.orders", at, ORDER_ID);
  assert.deepEqual(decodeListCursor("merchant.orders", cursor), {
    value: at.toISOString(),
    id: ORDER_ID,
  });
});

await test("is opaque — the value is not readable in the URL", () => {
  const cursor = encodeListCursor(
    "merchant.orders",
    new Date("2026-09-01T10:00:00.000Z"),
    ORDER_ID
  );
  assert.equal(
    cursor.includes(ORDER_ID),
    false,
    "a client that can read a cursor starts building one"
  );
  assert.equal(
    /^[A-Za-z0-9_-]+$/.test(cursor),
    true,
    "base64url only — it travels in a query string"
  );
});

await test("an absent cursor is the first page, not an error", () => {
  for (const value of [undefined, null, ""])
    assert.equal(decodeListCursor("merchant.orders", value), undefined);
});

await test("a cursor from ANOTHER list is a clean 400, not an empty page", () => {
  const cursor = encodeListCursor("merchant.customers", new Date(), ORDER_ID);
  const error = refusal(() => decodeListCursor("merchant.orders", cursor));
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 400);
  assert.equal(error.code, "INVALID_CURSOR");
});

await test("garbage is a 400 with a stable code — never a 500", () => {
  for (const value of [
    "abc",
    "!!!!",
    Buffer.from("not json", "utf8").toString("base64url"),
    Buffer.from('{"v":1}', "utf8").toString("base64url"),
    42,
    {},
    "x".repeat(600),
  ]) {
    const error = refusal(() => decodeListCursor("merchant.orders", value));
    assert.ok(error instanceof HttpError, `expected HttpError for ${String(value)}`);
    assert.equal(error.status, 400);
    assert.equal(error.code, "INVALID_CURSOR");
  }
});

await test("a cursor of an older version is refused rather than guessed at", () => {
  const stale = Buffer.from(
    JSON.stringify({ v: 0, k: "merchant.orders", c: new Date().toISOString(), i: ORDER_ID }),
    "utf8"
  ).toString("base64url");
  assert.equal(refusal(() => decodeListCursor("merchant.orders", stale)).status, 400);
});

await test("a cursor whose id is not a uuid is refused before Prisma sees it", () => {
  const forged = Buffer.from(
    JSON.stringify({ v: 1, k: "merchant.orders", c: new Date().toISOString(), i: "'; DROP TABLE" }),
    "utf8"
  ).toString("base64url");
  assert.equal(refusal(() => decodeListCursor("merchant.orders", forged)).code, "INVALID_CURSOR");
});

await test("a bare uuid minted before 20-2 still opens the page it pointed at", async () => {
  const at = new Date("2026-08-30T08:00:00.000Z");
  const cursor = await readListCursor("merchant.products", ORDER_ID, {
    legacy: async (id) => (id === ORDER_ID ? { value: at } : null),
  });
  assert.deepEqual(cursor, { value: at.toISOString(), id: ORDER_ID });
});

await test("a legacy uuid the caller cannot see is a 404, not an oracle", async () => {
  const error = await refusal(() =>
    readListCursor("merchant.products", OTHER_ID, { legacy: async () => null })
  );
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, 404);
  assert.equal(error.code, "RESOURCE_NOT_FOUND");
});

await test("a bare uuid on a list that never minted one is an ordinary 400", async () => {
  const error = await refusal(() => readListCursor("merchant.orders", ORDER_ID, {}));
  assert.equal(error.status, 400);
  assert.equal(error.code, "INVALID_CURSOR");
});

await test("the keyset predicate is bounded, so the index can open AT the cursor", () => {
  const at = new Date("2026-09-01T10:00:00.000Z");
  const cursor = decodeListCursor(
    "merchant.orders",
    encodeListCursor("merchant.orders", at, ORDER_ID)
  );
  // 20-3. The closed comparison is the whole point: a bare top-level OR cannot
  // be an index STARTING point, so PostgreSQL opened the index at the top and
  // filtered forward — a deep page then cost time proportional to its depth
  // even on a perfect index (6.350 ms at row 59,000 against 0.033 ms).
  assert.deepEqual(keysetWhere("createdAt", "desc", cursor), {
    AND: [
      { createdAt: { lte: at } },
      { OR: [{ createdAt: { lt: at } }, { id: { lt: ORDER_ID } }] },
    ],
  });
  assert.deepEqual(keysetWhere("sku", "asc", { value: "AB-1", id: ORDER_ID }, "text"), {
    AND: [{ sku: { gte: "AB-1" } }, { OR: [{ sku: { gt: "AB-1" } }, { id: { gt: ORDER_ID } }] }],
  });
  assert.deepEqual(keysetWhere("createdAt", "desc", undefined), {});
});

await test("…and selects EXACTLY the rows the old disjunction did", () => {
  // The shape assertion above says what it looks like; this says what it MEANS.
  // A faster predicate that quietly drops or repeats a row is a data bug, not an
  // optimisation, so the two forms are evaluated row by row over every ordering
  // relative to the cursor — before, at (both id sides), after — in both
  // directions, over a date column and a text one.
  const evaluate = (where, row) => {
    const [bound, disjunction] = where.AND;
    const [field] = Object.keys(bound);
    const compare = (test, value) =>
      "lt" in test
        ? value < test.lt
        : "lte" in test
          ? value <= test.lte
          : "gt" in test
            ? value > test.gt
            : value >= test.gte;
    if (!compare(bound[field], row[field])) return false;
    return disjunction.OR.some((clause) =>
      "id" in clause ? compare(clause.id, row.id) : compare(clause[field], row[field])
    );
  };
  const original = (field, direction, cursor, row) => {
    const beyond = direction === "desc" ? (a, b) => a < b : (a, b) => a > b;
    return (
      beyond(row[field], cursor.value) || (row[field] === cursor.value && beyond(row.id, cursor.id))
    );
  };

  for (const [field, parse, before, at, after] of [
    [
      "createdAt",
      "date",
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-09-01T10:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
    ],
    ["sku", "text", "AA-1", "AB-1", "AC-1"],
  ]) {
    const lowerId = "0f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const higherId = "7f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const cursor = { value: parse === "date" ? at.toISOString() : at, id: ORDER_ID };
    const parsed = { value: at, id: ORDER_ID };
    for (const direction of ["asc", "desc"]) {
      const where = keysetWhere(field, direction, cursor, parse);
      for (const value of [before, at, after]) {
        for (const id of [lowerId, ORDER_ID, higherId]) {
          const row = { [field]: value, id };
          assert.equal(
            evaluate(where, row),
            original(field, direction, parsed, row),
            `${field} ${direction}: row (${value}, ${id.slice(0, 8)}) is classified differently by the two forms`
          );
        }
      }
    }
  }
});

await test("the page cursor points at the LAST RETURNED row, never at the probe", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const { page, nextCursor } = pageOf(rows, 2, (last) => `cursor:${last.id}`);
  assert.deepEqual(page, [{ id: "a" }, { id: "b" }]);
  assert.equal(nextCursor, "cursor:b", "pointing at the un-returned probe row would skip it");
  assert.equal(pageOf(rows, 3, () => "x").nextCursor, null, "a full-but-final page ends the list");
});

await test("a bad limit is refused identically everywhere — no silent clamp", () => {
  assert.equal(parseListLimit(undefined), 25);
  assert.equal(parseListLimit(""), 25);
  assert.equal(parseListLimit("40"), 40);
  for (const value of ["0", "101", "-1", "2.5", "abc", "1e3"]) {
    const error = refusal(() => parseListLimit(value));
    assert.ok(error instanceof HttpError, `expected a refusal for limit=${value}`);
    assert.equal(error.status, 400);
    assert.equal(error.code, "INVALID_LIMIT");
  }
});

console.log(`\nlist:unit ok — ${passed} assertions groups passed.`);
