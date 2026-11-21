/**
 * D-67 / CVE-2026-82333 — one crafted FIELD NAME stops the whole platform.
 *
 * multer parses bracket notation in field names, so `items[4294967294]` makes
 * `append-field` allocate a sparse array of maximum length; a second field with
 * a non-numeric key on the same base converts it to an object by iterating that
 * whole length — synchronously, on the event loop. One request of a few hundred
 * bytes, no account and no session, and the single container serving the API,
 * every dashboard and every storefront stops answering anybody.
 *
 * WHY THIS GUARD EXISTS RATHER THAN A VERSION BUMP. multer 2.3.0 added the two
 * limits, but enforces each only when the key is PRESENT:
 *
 *     if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldArrayIndexLimit'))
 *
 * So `pnpm up multer` closes nothing at all, and the audit step goes green while
 * the platform stays exactly as exposed. What has to hold is that every one of
 * the six multer instances in the backend passes the option — which is why the
 * rule below is asserted on the SOURCE as well as on the behaviour.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";

process.env.SESSION_JWT_SECRET ??= "upload-limits-guard-secret-not-for-production";
process.env.DATABASE_URL ??=
  "postgresql://guard:guard@upload-guard-never-connects.invalid:5432/guard";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../src");
const summary = {};

// ============================================================
// 1. THE SOURCE RULE — no multer instance sets `limits` by hand.
// ============================================================
// A bare `limits: { fileSize, files }` is the defect: it type-checks, it reads
// as complete, and it silently opts out of the only thing standing between a
// stranger and a stalled event loop.
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

const offenders = [];
let multerInstances = 0;
for (const file of sourceFiles(srcRoot)) {
  const source = readFileSync(file, "utf8");
  if (!/\bmulter\(/.test(source)) continue;
  for (const match of source.matchAll(/\bmulter\(\{/g)) {
    multerInstances += 1;
    // The options object runs to the matching close; a generous window is enough
    // to see whichever `limits:` belongs to this call.
    const window = source.slice(match.index, match.index + 700);
    const limits = window.match(/limits:\s*([A-Za-z_$][\w$]*\(|\{)/);
    const line = source.slice(0, match.index).split("\n").length;
    if (!limits) {
      offenders.push(`${path.relative(srcRoot, file)}:${line} — no limits at all`);
      continue;
    }
    if (limits[1] !== "uploadLimits(")
      offenders.push(
        `${path.relative(srcRoot, file)}:${line} — limits written by hand as ${limits[1]}`
      );
  }
}

assert.equal(
  offenders.length,
  0,
  `every multer instance must take its limits from uploadLimits():\n  ${offenders.join("\n  ")}`
);
assert.ok(
  multerInstances >= 6,
  `the guard must still be finding the upload routes — found ${multerInstances}`
);
summary.sourceRule = `${multerInstances} multer instances, all of them through uploadLimits()`;

// ============================================================
// 2. What uploadLimits() actually returns.
// ============================================================
const { uploadLimits } = await import("../src/http/shared.ts");
const limits = uploadLimits({ fileSize: 1234, files: 3 });
assert.equal(limits.fileSize, 1234, "the caller's own ceiling is preserved");
assert.equal(limits.files, 3);
assert.equal(
  limits.fieldArrayIndexLimit,
  0,
  "no bracket index is accepted — the platform sends none"
);
assert.equal(limits.fieldNestingDepth, 0, "…and no nesting either, for the same reason");
summary.shape = "uploadLimits keeps the caller's fileSize/files and adds both field-name ceilings";

// ============================================================
// 3. THE BEHAVIOUR, through a real multipart request.
// ============================================================
// The source rule above can be satisfied by a `uploadLimits` that returns
// nothing useful. This is the half that cannot be faked: the attack body is
// sent to a real multer instance configured exactly as the routes are.
const multer = (await import("multer")).default;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: uploadLimits({ fileSize: 1024 * 1024, files: 1 }),
});

const server = http.createServer((request, response) => {
  upload.any()(request, response, (error) => {
    if (error) {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ rejected: true, code: error.code ?? String(error) }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ rejected: false, fields: Object.keys(request.body ?? {}) }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function post(fields) {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  const response = await fetch(base, { method: "POST", body: form });
  return { status: response.status, body: await response.json() };
}

// The attack, verbatim from the advisory: the huge index, then a non-numeric key
// on the same base that forces the sparse array to be walked.
const attack = await post([
  ["items[4294967294]", "x"],
  ["items[label]", "y"],
]);
assert.equal(
  attack.status,
  422,
  "the crafted field name is REFUSED — this is the vulnerability itself"
);
assert.ok(
  ["LIMIT_FIELD_ARRAY_INDEX", "LIMIT_FIELD_NESTING"].includes(attack.body.code),
  `…by one of multer's own limits, so errors.ts answers 422 in Arabic rather than 500 — got ${attack.body.code}`
);
summary.attackRefused = `«items[4294967294]» is refused with ${attack.body.code} before append-field ever sees it`;

// And the fields the platform actually sends still pass. A guard that closes the
// attack by breaking every upload is not a fix.
const ordinary = await post([
  ["image", "x"],
  ["linkUrl", "https://example.test"],
  ["altText", "شعار"],
  ["placement", "home"],
]);
assert.equal(
  ordinary.status,
  200,
  `the real field names must still be accepted — ${JSON.stringify(ordinary.body)}`
);
assert.deepEqual(
  ordinary.body.fields.sort(),
  ["altText", "image", "linkUrl", "placement"],
  "…all four of them, unchanged"
);
summary.ordinaryUnaffected =
  "image, linkUrl, altText and placement — every field name the platform sends — still pass";

server.close();
console.log(JSON.stringify({ suite: "upload-limits", status: "passed", summary }, null, 2));
