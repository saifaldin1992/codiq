/**
 * Guard — الوثيقة تطابق المسارات، وإلا سقط البناء (openapi:guard).
 *
 * WHAT THIS EXISTS TO STOP
 * ========================
 * A spec that drifts from the routes is worse than no spec, because an
 * integrator builds against it and finds out in production. The two drifts that
 * matter are opposites and this guard must catch BOTH:
 *
 *   · a route exists and the document does not describe it  →  the integrator
 *     never learns the endpoint is there, and the acceptance gate («وثيقة
 *     OpenAPI تغطي كل endpoints») is quietly unmet;
 *   · the document describes a route that no longer exists  →  the integrator
 *     writes a client against a 404 and blames his own code.
 *
 * HOW IT CANNOT BE SATISFIED BY ACCIDENT
 * ======================================
 * It does not read the document and look for problems. It REGENERATES the
 * document from `createApp()`'s live routing table and the zod schemas — the
 * same builder that wrote the committed copy — and demands the two be
 * byte-identical. There is no rule to be blind to, because there is no rule:
 * there is one function of the code, evaluated twice.
 *
 * That shape is chosen deliberately against this repo's own history of guards
 * that passed while the thing they guarded was broken:
 *
 *   · `validation-adoption.guard.mjs` asked «does a regex find a route here»
 *     and its regex could not see a single-line registration. It reported one
 *     offender where there were eight.
 *   · `serializable-retry.unit.mjs` asked «numeric bound AND no mention of the
 *     constant», so a HALF-converted loop answered correctly and the checkout
 *     budget stayed at three.
 *   · 20-2's first ratchet indexed a function body from «the first `{` after
 *     the name» and landed on a type annotation, missing the one offender it
 *     was written for.
 *
 * All three are the same mistake: a PROXY for the truth, cheap enough to fool.
 * Regeneration has no proxy. Add a route and the regenerated document has it
 * and the committed one does not. Delete an entry and the same. Leave a stale
 * entry and the same. Edit a zod schema and the same.
 *
 * The builder carries its own second reading on top of that: it refuses to
 * produce anything at all unless the Express routing table and a static scan of
 * the route sources agree, in both directions.
 *
 * THE CHECKS BEYOND THE DIFF
 * ==========================
 * A byte-diff cannot notice that the builder ITSELF degraded — that it emitted
 * two hundred operations with no door, no schema and no error codes, and that
 * the committed copy is a faithful record of that degradation. So the assertions
 * below are about the document's substance, and each one is a thing that has
 * to stay true no matter how the generator is refactored.
 *
 * Run: pnpm openapi:guard
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  JSON_OUTPUT,
  TS_OUTPUT,
  buildOpenApiDocument,
  renderJson,
  renderTs,
} from "../scripts/generate-openapi.mjs";

/**
 * Line endings are normalised before comparing, and only line endings.
 *
 * `core.autocrlf=true` is the Windows default and this repo has developers on
 * it. Without this, a clean checkout would fail the guard on Windows and pass
 * in CI — the worst possible failure for a gate, because the person who can
 * reproduce it is not the person the gate is protecting.
 */
const sameContent = (a, b) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

const failures = [];
const summary = {};

// ===========================================================================
// 1. Regenerate and compare. This is the whole guard; the rest is about the
//    generator not having quietly degraded.
// ===========================================================================
const document = await buildOpenApiDocument();

for (const [label, file, rendered] of [
  ["docs/openapi.json", JSON_OUTPUT, renderJson(document)],
  ["phase1-backend/src/http/openapi.document.ts", TS_OUTPUT, renderTs(document)],
]) {
  let committed;
  try {
    committed = readFileSync(file, "utf8");
  } catch {
    failures.push(`${label} is missing entirely. Run \`pnpm openapi:generate\`.`);
    continue;
  }
  if (sameContent(committed, rendered)) continue;
  failures.push(
    `${label} does not match what the routes produce.\n${describeDrift(committed, rendered)}\n      Fix: \`pnpm openapi:generate\`, then read the diff — it names every endpoint that changed.`
  );
}
summary.regenerated =
  "the committed document is byte-identical to one built from the live routing table";

/**
 * Which endpoints moved, not «the files differ». A 900 KB diff is unreadable;
 * the endpoint list is the thing a reviewer needs and it is two lines away.
 */
function describeDrift(committed, rendered) {
  const lines = [];
  const committedPaths = pathKeysOf(committed);
  const renderedPaths = pathKeysOf(rendered);
  if (committedPaths && renderedPaths) {
    const added = [...renderedPaths].filter((key) => !committedPaths.has(key)).sort();
    const removed = [...committedPaths].filter((key) => !renderedPaths.has(key)).sort();
    if (added.length)
      lines.push(
        `      ${added.length} endpoint(s) the routes have and the document does not:\n${added.map((key) => `        + ${key}`).join("\n")}`
      );
    if (removed.length)
      lines.push(
        `      ${removed.length} endpoint(s) the document has and the routes do not:\n${removed.map((key) => `        - ${key}`).join("\n")}`
      );
    if (!added.length && !removed.length)
      lines.push(
        "      The same endpoints, but their described shapes differ — a schema, a door, an error code or a parameter changed."
      );
  }
  return lines.join("\n");
}

function pathKeysOf(text) {
  // The TS module wraps the document in a declaration, and its FIRST `{` is the
  // interface body — parsing from there yields nothing and the failure message
  // degrades to «the files differ», which is the message this function exists
  // to avoid printing.
  const marker = "openApiDocument: OpenApiDocument = ";
  const markerIndex = text.indexOf(marker);
  const start = markerIndex === -1 ? text.indexOf("{") : markerIndex + marker.length;
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
    const keys = new Set();
    for (const [route, item] of Object.entries(parsed.paths ?? {})) {
      for (const method of Object.keys(item))
        if (method !== "servers") keys.add(`${method.toUpperCase()} ${route}`);
    }
    return keys;
  } catch {
    return null;
  }
}

// ===========================================================================
// 2. The document still says something. Every assertion here is a way the
//    generator could degrade into producing a large, well-formed, useless file.
// ===========================================================================
const operations = [];
for (const [route, item] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (method === "servers") continue;
    operations.push({ key: `${method.toUpperCase()} ${route}`, route, method, operation });
  }
}

assert.ok(
  operations.length > 200,
  `the platform has more than two hundred endpoints; the document describes ${operations.length}`
);
summary.operations = operations.length;

const operationIds = new Map();
const undocumented = [];
const doorless = [];
const errorless = [];
const unresolvedRefs = new Set();
const declaredCodes = new Set(Object.keys(document["x-codiq-error-catalogue"] ?? {}));
const uncataloguedCodes = new Set();

for (const { key, route, operation } of operations) {
  if (!route.startsWith("/")) failures.push(`${key}: a path template must start with «/»`);
  if (/:/.test(route))
    failures.push(
      `${key}: an Express «:param» leaked into the path template — OpenAPI uses «{param}»`
    );
  if (operationIds.has(operation.operationId))
    failures.push(
      `operationId «${operation.operationId}» is used by both ${operationIds.get(operation.operationId)} and ${key} — a generated client would collide`
    );
  operationIds.set(operation.operationId, key);

  // Every operation must name a door, even if the door is «open».
  if (!Array.isArray(operation["x-codiq-identity"]) || operation["x-codiq-identity"].length === 0)
    doorless.push(key);
  // …and must say what happens when the request is refused.
  const statuses = Object.keys(operation.responses ?? {});
  if (!statuses.some((status) => Number(status) >= 400)) errorless.push(key);
  if (!statuses.some((status) => Number(status) >= 200 && Number(status) < 400))
    undocumented.push(`${key}: no success response`);

  // Every path parameter in the template must be declared, or a generated
  // client cannot build the URL at all.
  const templated = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const declared = new Set(
    (operation.parameters ?? [])
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => parameter.name)
  );
  for (const name of templated)
    if (!declared.has(name))
      failures.push(`${key}: «{${name}}» is in the path template but is not a declared parameter`);

  for (const response of Object.values(operation.responses ?? {})) {
    for (const code of response["x-codiq-error-codes"] ?? [])
      if (!declaredCodes.has(code)) uncataloguedCodes.add(`${key} → ${code}`);
  }
  collectRefs(operation, unresolvedRefs);
}

if (doorless.length)
  failures.push(
    `${doorless.length} operation(s) name no identity at all — the generator lost the guard, it did not find a public route:\n${doorless.map((key) => `        · ${key}`).join("\n")}`
  );
if (errorless.length)
  failures.push(
    `${errorless.length} operation(s) document no failure. Every route on this platform can answer 400, 413 and 500 from the shared handler alone:\n${errorless.map((key) => `        · ${key}`).join("\n")}`
  );
for (const line of undocumented) failures.push(line);
if (uncataloguedCodes.size)
  failures.push(
    `error code(s) referenced by an operation but absent from x-codiq-error-catalogue — the enum on ErrorEnvelope.error.code would refuse a code the platform actually sends:\n${[...uncataloguedCodes].map((line) => `        · ${line}`).join("\n")}`
  );

// Every `$ref` must resolve. A dangling one turns a described shape into
// nothing, and no tool reports it until an integrator's generator crashes.
function collectRefs(node, into, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      const segments = value.replace(/^#\//, "").split("/");
      let target = document;
      for (const segment of segments)
        target = target?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
      if (target === undefined) into.add(value);
      continue;
    }
    collectRefs(value, into, seen);
  }
}
collectRefs(document.components, unresolvedRefs);
if (unresolvedRefs.size) failures.push(`unresolved $ref(s): ${[...unresolvedRefs].join(", ")}`);
summary.refs = "every $ref in the document resolves";

// ===========================================================================
// 3. The decisions this phase made must be IN the document, not only in a
//    commit message. Each of these is a fact a client will act on.
// ===========================================================================
assert.equal(
  document.openapi,
  "3.1.0",
  "3.1 is chosen so zod's JSON Schema 2020-12 output drops in unconverted"
);
assert.deepEqual(
  document.servers.map((server) => server.url),
  ["/api/v1", "/api"],
  "both mounts are declared, versioned first — the order clients read as «prefer this one»"
);

const storefrontOperations = operations.filter(
  ({ route }) => route === "/store" || route.startsWith("/store/")
);
assert.ok(
  storefrontOperations.length > 20,
  `the storefront is a large surface; found ${storefrontOperations.length} operations`
);
for (const { route } of storefrontOperations) {
  const servers = document.paths[route].servers;
  assert.deepEqual(
    servers?.map((server) => server.url),
    ["/api"],
    `${route} must be pinned to /api alone: the customer cookie is scoped to /api/store/{storeSlug}, so a versioned copy of this route hands the shopper a cookie his browser will not send back`
  );
}
summary.storefrontPinned = `${storefrontOperations.length} storefront operations are pinned to /api — the exception is machine-readable, not prose`;

// The five identity kinds gate this platform. The document must speak of them
// by name, or «which door» has quietly become a guess.
const kinds = new Set(operations.flatMap(({ operation }) => operation["x-codiq-identity"] ?? []));
for (const kind of ["platform_owner", "platform_staff", "merchant", "staff", "customer"]) {
  assert.ok(
    kinds.has(kind),
    `no operation is documented as requiring «${kind}» — the guard detection for that door has broken`
  );
}
summary.identities = [...kinds].sort().join(", ");

// The error envelope is a contract phase 22 will translate BY CODE.
const envelope = document.components.schemas.ErrorEnvelope;
assert.deepEqual(
  envelope.properties.error.required,
  ["code", "message", "requestId"],
  "the envelope is { error: { code, message, requestId } } and has been since 24-أ"
);
assert.ok(
  envelope.properties.error.properties.code.enum.length > 150,
  "the code enum is generated from the throw sites; a short one means the scan stopped finding them"
);
assert.ok(
  envelope.properties.error.properties.code.enum.includes("VALIDATION_FAILED"),
  "the most common refusal on the platform must be in the enum"
);
assert.ok(envelope.properties.error.properties.code.enum.includes("RATE_LIMITED"));
assert.ok(
  envelope.properties.error.properties.code.enum.includes("STORE_BOUNDARY_DENIED"),
  "the tenancy wall's own refusal"
);
summary.errorCodes = envelope.properties.error.properties.code.enum.length;

// 20-2's envelope is described ONCE and referenced, never repeated per route.
const listOperations = operations.filter(({ operation }) => operation["x-codiq-list-envelope"]);
assert.ok(
  listOperations.length > 20,
  `the platform has many paginated lists; found ${listOperations.length}`
);
for (const { key, operation } of listOperations) {
  const success = Object.entries(operation.responses).find(([status]) => Number(status) < 400)?.[1];
  const schema = success?.content?.["application/json"]?.schema;
  assert.ok(
    schema?.allOf?.some((part) => part.$ref === "#/components/schemas/ListEnvelope"),
    `${key} is a list route but does not reference the shared ListEnvelope — 20-2's contract described twice is 20-2's contract undone`
  );
}
summary.lists = `${listOperations.length} list operations reference the one ListEnvelope component`;

// A body-validated route must carry the schema, not a shrug.
const validated = operations.filter(
  ({ operation }) => operation.requestBody?.content?.["application/json"]
);
assert.ok(
  validated.length > 60,
  `19-ج put zod on every write; only ${validated.length} operations carry a JSON request schema`
);
for (const { key, operation } of validated) {
  const ref = operation.requestBody.content["application/json"].schema.$ref;
  assert.ok(
    ref?.startsWith("#/components/schemas/"),
    `${key}: the request body must reference a generated schema component, not an inline shrug`
  );
}
summary.requestSchemas = `${validated.length} operations carry a zod-derived request body schema`;

// ===========================================================================
if (failures.length) {
  console.error("openapi:guard FAILED\n");
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}

console.log(JSON.stringify({ suite: "openapi", status: "passed", summary }, null, 2));
