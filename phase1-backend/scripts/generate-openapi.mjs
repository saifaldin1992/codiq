/**
 * المرحلة 20-4 — توليد وثيقة OpenAPI من الشيفرة التي تعمل فعلاً.
 *
 * WHY THIS IS GENERATED AND NEVER WRITTEN BY HAND
 * ==============================================
 * A hand-maintained spec is the exact failure mode this codebase spent the week
 * removing: a tool that reassures without working. In one day we found a state
 * document wrong in twelve places, a debt register that called a shipped index
 * «missing», a guard fooled by a half-done conversion, and a runbook whose three
 * recovery paths all assumed a database row that did not exist. A spec that
 * drifts from the routes is WORSE than no spec, because an integrator builds
 * against it and only finds out in production.
 *
 * So every fact in the document is read from something that is already the
 * authority for it:
 *
 *   PATHS AND METHODS  — from `createApp()`'s own Express router, at runtime.
 *                        Not from a list, not from a regex over the sources:
 *                        from the routing table the server will actually use.
 *   REQUEST SHAPES     — from the zod schemas in `src/http/schemas/`, which
 *                        19-ج made the single authority for input, converted by
 *                        zod 4's OWN `z.toJSONSchema`.
 *   WHICH DOOR         — from the guard the handler calls (`requireStoreActor`,
 *                        `requirePlatformOwner`, `requireStorefrontCustomer`…),
 *                        including the permission code it demands.
 *   ERROR CODES        — from every `new HttpError(status, "CODE", "…")` in the
 *                        backend plus `classifyError`'s own table. Those Arabic
 *                        messages are a CONTRACT: phase 22 translates them BY
 *                        CODE, so the catalogue is generated from the throw
 *                        sites rather than transcribed beside them.
 *   THE LIST ENVELOPE  — described ONCE as a component and referenced, exactly
 *                        as 20-2 defined it.
 *
 * THE PART THAT MAKES IT UN-FOOLABLE
 * ==================================
 * Two independent readings of the same truth must agree, or nothing is written.
 *
 * The RUNTIME router gives the authoritative set of (method, path). The STATIC
 * scan of the route sources gives the metadata. `crossCheck()` then demands
 * that the two sets be IDENTICAL, in both directions, and throws otherwise.
 *
 * That is deliberate, and it is aimed at a specific way three of this repo's
 * guards have already been fooled:
 *
 *   · `validation-adoption.guard.mjs` detected routes with one regex that was
 *     blind to single-line registrations, and reported 1 offender where there
 *     were 8. `catalog.ts` writes twenty routes on single lines.
 *   · `serializable-retry.unit.mjs` asked a question a HALF-converted loop could
 *     answer correctly, and the checkout budget stayed at three.
 *   · 20-2's first ratchet indexed function bodies by «the first `{` after the
 *     name» and hit a TYPE ANNOTATION, missing the literal offender it was
 *     written to catch.
 *
 * All three share one shape: a single reading of the code, trusted alone. Here,
 * if the static scan misses a route, the runtime router still has it and
 * generation FAILS LOUDLY instead of quietly emitting an incomplete document.
 * The only way to produce a document is for both readings to see the same API.
 *
 * WHY NO NEW DEPENDENCY (ق-137)
 * =============================
 * `zod@4.1.12` ships `z.toJSONSchema()` in core. `@asteasolutions/zod-to-openapi`
 * and friends would add a package, a version to track, and a second opinion
 * about what a zod schema means — for a conversion the library we already
 * depend on performs itself. The standing bias against new dependencies (the
 * landing page ships its own service worker rather than take one) is honoured
 * without argument here, because there is nothing to argue about.
 *
 * OpenAPI 3.1.0 is chosen for the same reason: 3.1 IS JSON Schema 2020-12, so
 * `z.toJSONSchema(..., { target: "draft-2020-12" })` output drops straight in.
 * Targeting 3.0 would mean a lossy down-conversion (nullable, exclusiveMinimum,
 * const) and a second place for the shapes to be subtly wrong.
 *
 * Run: pnpm openapi:generate   ·   Checked by: pnpm openapi:guard
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CORE_SCHEMAS_DIR, routeSourceFiles, schemaSourceFiles } from "../source-layout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SRC = path.join(REPO, "phase1-backend", "src");
const ROUTES_DIR = path.join(SRC, "http", "routes");
const SCHEMAS_DIR = path.join(SRC, "http", "schemas");
const APP_FILE = path.join(SRC, "http", "app.ts");

export const JSON_OUTPUT = path.join(REPO, "docs", "openapi.json");
export const TS_OUTPUT = path.join(SRC, "http", "openapi.document.ts");

/**
 * Routes whose registration is CONDITIONAL, so the router of an ordinary
 * environment legitimately does not have them.
 *
 * Found by the cross-check on its very first run, which is the argument for
 * the cross-check: nobody remembered this route was flag-gated. An entry must
 * name the condition, and a stale one — a route that is now unconditional, or
 * gone — fails generation like any other disagreement. This is the ONLY escape
 * hatch in the check, and the list may only shrink.
 */
const CONDITIONAL_ROUTES = {
  "POST /public/demo-login": {
    condition: "config.demoMode",
    note: "P27-7: مسجَّل في بيئة العرض التوضيحي فقط. في الإنتاج والتجهيز لا وجود لهذا المسار أصلاً — 404، لا 403 يؤكّد وجود الميزة.",
  },
};

// ---------------------------------------------------------------------------
// 1. A tokenizer, because «the next `app.` line» is how guards get fooled.
// ---------------------------------------------------------------------------

/**
 * The exact extent of `app.get( … )`, by balancing parentheses from the opening
 * one — with strings, template literals and comments skipped.
 *
 * The cheap alternative (slice from this route to wherever the next one starts)
 * is what `validation-adoption.guard.mjs` did, and its blind spot cost a false
 * «fully validated» reading. It also cannot bound the LAST route in a file, and
 * it silently swallows any non-route statement sitting between two routes. This
 * costs forty lines and has no blind spot: `//` and `/* *\/` comments and all
 * three string forms are skipped, so an Arabic message containing a bracket —
 * «الحد المسموح (1 ميغابايت)» is real, in errors.ts — cannot unbalance it.
 *
 * A `/` is read as the start of a regex literal only where a regex is the only
 * legal reading (after an operator, an opening bracket, or a comma). No route
 * file contains a regex literal today; the branch exists so that the day one
 * arrives it is skipped rather than mistaken for division and left unbalanced.
 */
function extentFrom(source, openParenIndex) {
  let depth = 0;
  let previousMeaningful = "";
  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      i = skipString(source, i);
      previousMeaningful = char;
      continue;
    }
    if (char === "/" && /[(,=:[!&|?{;+\-*%<>]/.test(previousMeaningful)) {
      i = skipRegex(source, i);
      previousMeaningful = "/";
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
    if (!/\s/.test(char)) previousMeaningful = char;
  }
  throw new Error(`unbalanced route registration starting at offset ${openParenIndex}`);
}

function skipString(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") { i += 1; continue; }
    // A template literal's `${ … }` may contain anything, brackets included.
    if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      for (; i < source.length && depth > 0; i += 1) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") depth -= 1;
        else if (source[i] === '"' || source[i] === "'" || source[i] === "`") i = skipString(source, i);
      }
      i -= 1;
      continue;
    }
    if (source[i] === quote) return i;
  }
  throw new Error("unterminated string literal");
}

function skipRegex(source, start) {
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") { i += 1; continue; }
    if (source[i] === "[") { while (i < source.length && source[i] !== "]") { if (source[i] === "\\") i += 1; i += 1; } continue; }
    if (source[i] === "/") return i;
    if (source[i] === "\n") throw new Error("unterminated regex literal");
  }
  throw new Error("unterminated regex literal");
}

/**
 * The top-level arguments of `( … )`, split on commas at depth zero.
 *
 * Needed for one shape that is easy to miss and was: a route whose handler is a
 * BARE IDENTIFIER — `app.get("/merchant/stores/:storeSlug/dashboard",
 * requireMerchantStoreAccess)`. Nothing in that line is followed by `(`, so a
 * scan that follows «names that are called» sees an empty handler and reports
 * the route as OPEN TO ANYONE. It is not: it is a merchant-session probe. Two
 * routes on this platform are written that way and both are session-guarded.
 */
function topLevelArguments(extent) {
  const args = [];
  let depth = 0;
  let start = 1;
  for (let i = 0; i < extent.length; i += 1) {
    const char = extent[i];
    if (char === '"' || char === "'" || char === "`") { i = skipString(extent, i); continue; }
    if (char === "/" && extent[i + 1] === "/") { const end = extent.indexOf("\n", i); if (end === -1) break; i = end; continue; }
    if (char === "/" && extent[i + 1] === "*") { const end = extent.indexOf("*/", i + 2); if (end === -1) break; i = end + 1; continue; }
    if (char === "(" || char === "[" || char === "{") { depth += 1; continue; }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) { args.push(extent.slice(start, i)); break; }
      continue;
    }
    if (char === "," && depth === 1) { args.push(extent.slice(start, i)); start = i + 1; }
  }
  return args.map((argument) => argument.trim());
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/** Every route registration in one file, each with its exact source extent. */
function routeRegistrations(source) {
  const pattern = new RegExp(`\\bapp\\.(${HTTP_METHODS.join("|")})\\s*\\(`, "g");
  const found = [];
  let match;
  while ((match = pattern.exec(source))) {
    const openParen = match.index + match[0].length - 1;
    const extent = extentFrom(source, openParen);
    const literal = /^\(\s*(["'])([^"'`]+)\1/.exec(extent);
    // `app.get(somethingComputed, …)` would land here. It does not exist today,
    // and if it ever does the cross-check turns it into a loud failure rather
    // than a route missing from the document.
    if (!literal) continue;
    found.push({ method: match[1].toUpperCase(), expressPath: literal[2], body: extent });
    pattern.lastIndex = openParen + extent.length;
  }
  return found;
}

// ---------------------------------------------------------------------------
// 2. Function bodies, for the one hop into helpers and services.
// ---------------------------------------------------------------------------

/**
 * name → body text. The skipping of type parameters, the parameter list and the
 * return type is lifted from `list-envelope.guard.mjs`, INCLUDING the reason it
 * is written that way: taking «the first `{` after the name» lands on a type
 * annotation (`store: { id: string }`, `Promise<{ nextCursor: string | null }>`)
 * and truncates the indexed body to nothing. That bug made 20-2's first ratchet
 * miss the single offender it existed to catch.
 */
function indexFunctions(source, into) {
  const declaration = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?=[<(]|function\b)/g;
  let match;
  while ((match = declaration.exec(source))) {
    const name = match[1] ?? match[2];
    let i = declaration.lastIndex;
    const skipSpace = () => { while (i < source.length && /\s/.test(source[i])) i += 1; };
    skipSpace();
    if (source.startsWith("function", i)) { i += "function".length; skipSpace(); }
    if (source[i] === "<") {
      let angle = 0;
      for (; i < source.length; i += 1) {
        if (source[i] === "<") angle += 1;
        else if (source[i] === ">") { angle -= 1; if (angle === 0) { i += 1; break; } }
      }
      skipSpace();
    }
    if (source[i] !== "(") continue;
    let parens = 0;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") parens += 1;
      else if (source[i] === ")") { parens -= 1; if (parens === 0) { i += 1; break; } }
    }
    let angle = 0;
    let open = -1;
    for (; i < source.length; i += 1) {
      const char = source[i];
      if (char === "<") angle += 1;
      else if (char === ">") angle = Math.max(0, angle - 1);
      else if (char === ";" && angle === 0) break;
      else if (char === "{" && angle === 0) { open = i; break; }
    }
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") { depth -= 1; if (depth === 0) break; }
    }
    into.set(name, (into.get(name) ?? "") + "\n" + source.slice(open, Math.min(end + 1, source.length)));
  }
}

/**
 * `const NAME = <expression>` bodies, for the initializers `indexFunctions`
 * cannot see.
 *
 * `indexFunctions` only indexes a `const` whose initializer opens with `(`,
 * `<` or `function` — an arrow or a function expression. But
 * `const requireCustomerStoreAccess = asyncRoute(async (request, response) => …)`
 * opens with an IDENTIFIER, so the guard standing behind two route
 * registrations was invisible, and both routes were about to be documented as
 * needing no session at all. Indexing the whole balanced initializer costs
 * nothing and closes the hole for every wrapper of this shape.
 */
function indexConstInitializers(source, into) {
  const declaration = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*/g;
  let match;
  while ((match = declaration.exec(source))) {
    const name = match[1];
    const start = declaration.lastIndex;
    let depth = 0;
    let i = start;
    for (; i < source.length; i += 1) {
      const char = source[i];
      if (char === '"' || char === "'" || char === "`") { i = skipString(source, i); continue; }
      if (char === "/" && source[i + 1] === "/") { const end = source.indexOf("\n", i); if (end === -1) { i = source.length; break; } i = end; continue; }
      if (char === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); if (end === -1) { i = source.length; break; } i = end + 1; continue; }
      if (char === "(" || char === "[" || char === "{") { depth += 1; continue; }
      if (char === ")" || char === "]" || char === "}") { depth -= 1; if (depth < 0) break; continue; }
      if (depth === 0 && (char === ";" || char === "\n")) break;
    }
    into.set(name, (into.get(name) ?? "") + "\n" + source.slice(start, Math.min(i + 1, source.length)));
    declaration.lastIndex = Math.min(i + 1, source.length);
  }
}

// ---------------------------------------------------------------------------
// 3. The doors. Which identity a route demands, read from the guard it calls.
// ---------------------------------------------------------------------------

/**
 * Guard call → the identity kinds it accepts. Five kinds gate this platform:
 * `platform_owner`, `platform_staff`, `merchant`, `staff`, `customer`.
 *
 * `requireStoreActor` accepts a merchant OR a member of his staff and then
 * checks a permission code, which is why its entry carries both kinds; the code
 * itself is read from the call and reported separately.
 */
const IDENTITY_GUARDS = [
  { call: "requirePlatformOwner", kinds: ["platform_owner"] },
  { call: "requirePlatformActor", kinds: ["platform_owner", "platform_staff"] },
  { call: "requirePlatformStaff", kinds: ["platform_staff"] },
  { call: "requireStoreActorAny", kinds: ["merchant", "staff"] },
  { call: "requireStoreActor", kinds: ["merchant", "staff"] },
  { call: "requireStoreStaff", kinds: ["staff"] },
  { call: "requireMerchantStore", kinds: ["merchant"] },
  { call: "requireStorefrontCustomer", kinds: ["customer"] },
  { call: "requireCustomerStoreAccess", kinds: ["customer"] },
  { call: "customerToken", kinds: ["customer"] },
];

function identityOf(body) {
  const kinds = new Set();
  const permissions = new Set();
  for (const guard of IDENTITY_GUARDS) {
    if (!new RegExp(`\\b${guard.call}\\s*\\(`).test(body)) continue;
    for (const kind of guard.kinds) kinds.add(kind);
  }
  // `requireKind("platform_owner")` and `verifyTypedSession(token, "staff")`
  // name the kind in the call itself.
  for (const match of body.matchAll(/\brequireKind\s*\(\s*"([a-z_]+)"/g)) kinds.add(match[1]);
  // One level of nesting allowed on purpose: the real call is
  // `verifyTypedSession(bearerToken(request), "customer")`, and a `[^)]*` that
  // stopped at the first `)` read the kind as absent and reported a
  // customer-only route as «any signed-in identity».
  for (const match of body.matchAll(/\bverifyTypedSession\s*\((?:[^()]|\([^()]*\))*?,\s*"([a-z_]+)"\s*\)/g)) kinds.add(match[1]);
  for (const match of body.matchAll(/\brequire(?:StoreActor|StoreActorAny|PlatformActor)\s*\(\s*request\s*,\s*(\[[^\]]*\]|"[^"]+")/g)) {
    for (const code of match[1].matchAll(/"([^"]+)"/g)) permissions.add(code[1]);
  }
  // A route that reads a session token with no typed guard still needs ONE — it
  // is reported as «any signed-in identity» rather than as public.
  if (kinds.size === 0 && /\bbearerToken\s*\(/.test(body)) kinds.add("any-session");
  return { kinds: [...kinds].sort(), permissions: [...permissions].sort() };
}

// ---------------------------------------------------------------------------
// 4. The error catalogue — generated from the throw sites, not transcribed.
// ---------------------------------------------------------------------------

/**
 * Every `new HttpError(status, "CODE", "message")` in the backend, plus the
 * table in `classifyError`.
 *
 * The Arabic messages are a CONTRACT. Phase 22 translates them BY CODE and the
 * red team's fixes name them, so this catalogue is the thing an integrator and
 * a translator both read — and it is derived from the throw sites so that
 * neither can be reading a copy that has drifted.
 */
function buildErrorCatalogue() {
  const catalogue = new Map();
  const record = (code, status, message) => {
    const existing = catalogue.get(code) ?? { statuses: new Set(), messages: new Set() };
    existing.statuses.add(Number(status));
    // A template literal is a message SHAPE, not a message. `VALIDATION_FAILED`
    // builds its sentence from the offending field, so publishing
    // `${first.message} (${first.path})` as the contract text would be worse
    // than publishing nothing. The CODE and the status are what matter and they
    // are recorded either way — which is the reason the backtick form is matched
    // at all: without it `VALIDATION_FAILED`, the single most common refusal on
    // the platform, was absent from the catalogue and from the code enum that
    // every error response in this document references.
    // The message is read as SOURCE text, so decode the escapes JavaScript would:
    // a direction mark written visibly as \u200E (lint: no hidden bidi characters
    // in source) must reach the document as the character, not as six letters.
    if (message && !message.includes("${")) existing.messages.add(message.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
    catalogue.set(code, existing);
  };
  for (const file of allTsFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    // TWO PASSES, and the cheap one comes first for a reason. The message-bearing
    // pattern needs a string literal immediately after the code, and
    // `validate.ts` writes its message on the far side of a comment and a
    // ternary. Matching only the rich form dropped `VALIDATION_FAILED` — the
    // most common refusal on the platform, referenced by seventy-nine
    // operations in this very document — out of the code enum entirely.
    // Completeness of the CODES is the contract; the messages are a bonus.
    for (const match of source.matchAll(/new HttpError\(\s*(\d{3})\s*,\s*"([A-Z0-9_]+)"/g)) record(match[2], match[1], "");
    for (const match of source.matchAll(/new HttpError\(\s*(\d{3})\s*,\s*"([A-Z0-9_]+)"\s*,\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/g)) {
      record(match[2], match[1], match[4]);
    }
    // `classifyError` writes its answers as object literals, not as throws.
    for (const match of source.matchAll(/status:\s*(\d{3})\s*,\s*error:\s*\{\s*code:\s*"([A-Z0-9_]+)"\s*,\s*message:\s*(["'])((?:\\.|(?!\3)[^\\])*)\3/g)) {
      record(match[2], match[1], match[4]);
    }
    // A route that writes its refusal by hand instead of throwing. Exactly one
    // does (the CSV import — see HAND_WRITTEN_ERROR_BODIES), and its code was
    // absent from the catalogue and from its own operation's 422 until this
    // line existed: the document listed the five codes the route THROWS and
    // omitted the one it actually answers with in the ordinary failure.
    for (const match of source.matchAll(/response\s*\.\s*status\s*\(\s*(\d{3})\s*\)\s*\.\s*json\s*\(\s*\{\s*error:\s*\{\s*code:\s*"([A-Z0-9_]+)"\s*,\s*message:\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/g)) {
      record(match[2], match[1], match[4]);
    }
    // The soft-delete FK table names its codes in rows rather than at a throw.
    for (const match of source.matchAll(/code:\s*"([A-Z0-9_]+)"\s*,\s*status:\s*(\d{3})/g)) record(match[1], match[2], "");
  }
  return catalogue;
}

function allTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. zod → JSON Schema, through zod's own converter.
// ---------------------------------------------------------------------------

/**
 * Every zod schema in `src/http/schemas/`, keyed `module.exportName`.
 *
 * QUALIFIED BY MODULE, NOT BY NAME, and that is not tidiness. The first run of
 * this generator found `registerMerchantSchema` exported by BOTH
 * `auth.schema.ts` (5 fields, two of them deliberately `unknown`) and
 * `registration.schema.ts` (7 required strings). They belong to two different
 * doors — `POST /auth/merchant/register` and `POST /public/merchants/register`
 * — and a name-keyed lookup would have handed an integrator one endpoint's body
 * shape for the other's. (ق-183 deleted the first door; the rule stays, because
 * the collision it prevents is one of names, not of that one route.) Exactly the kind of confident, wrong document the whole
 * phase exists to prevent, and it was one lookup away.
 *
 * So the resolution follows the ROUTE FILE'S OWN IMPORT: whatever
 * `parseOrThrow(registerMerchantSchema, …)` means in `auth.ts` is whatever
 * `auth.ts` imported under that name.
 */
/**
 * Core schema files keep the bare qualifier every existing reference uses
 * («catalog»); a module's schema is qualified by its path («modules/<id>/schema»)
 * so two modules' `schema.ts` never collide.
 */
function schemaQualifier(file) {
  if (path.dirname(file) === CORE_SCHEMAS_DIR) return path.basename(file).replace(/\.schema\.ts$|\.ts$/, "");
  return path.relative(SRC, file).replace(/\\/g, "/").replace(/\.ts$/, "");
}
const SCHEMA_FILES = new Set(schemaSourceFiles());

async function loadSchemaModules() {
  const byQualifiedName = new Map();
  for (const file of SCHEMA_FILES) {
    const moduleBase = schemaQualifier(file);
    const module = await import(new URL(`file://${file.replace(/\\/g, "/")}`).href);
    for (const [name, value] of Object.entries(module)) {
      if (!value || typeof value !== "object" || typeof value.safeParse !== "function") continue;
      byQualifiedName.set(`${moduleBase}.${name}`, value);
    }
  }
  return byQualifiedName;
}

/** local import name → `module.exportName`, for one route file. */
function schemaImportsOf(source, file) {
  const bindings = new Map();
  for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g)) {
    const specifier = match[2];
    if (!specifier.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
    if (!SCHEMA_FILES.has(resolved)) continue;
    const moduleBase = schemaQualifier(resolved);
    for (const clause of match[1].split(",")) {
      const parts = clause.trim().split(/\s+as\s+/);
      const exported = parts[0].trim();
      const local = (parts[1] ?? parts[0]).trim();
      if (!exported || !local) continue;
      bindings.set(local, `${moduleBase}.${exported}`);
    }
  }
  return bindings;
}

function toJsonSchema(schema, name) {
  try {
    const converted = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      // The document describes what a CLIENT sends, so the pre-transform shape
      // is the right one: `listLimitSchema` is `z.unknown().transform(…)`, and
      // its output type (a number) is not what goes on the wire.
      io: "input",
      // A `z.custom` or a transform with no representable input becomes `true`
      // («any») rather than aborting the whole document. Marked in the
      // description so nobody reads «any» as «unconstrained by design».
      unrepresentable: "any",
    });
    delete converted.$schema;
    return converted;
  } catch (error) {
    throw new Error(`zod schema «${name}» could not be converted: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Reading one route's metadata.
// ---------------------------------------------------------------------------

const BODY_SCHEMA = /parseOrThrow\(\s*([A-Za-z_$][\w$]*)\s*,\s*(?:request\.body|body)|validateBody\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
/**
 * The third alternative is not decoration. `catalog.ts` validates its search
 * parameter as `parseOrThrow(catalogProductSearchQuerySchema, { q: request.query.q })`
 * — a hand-built object, not `request.query` itself — and the first two patterns
 * are blind to it. Missing it does not lose the parameter (it is still read off
 * `request.query` and documented), it loses its SCHEMA, and the document would
 * quietly downgrade a validated, bounded input to «a string, apparently».
 */
const QUERY_SCHEMA = /parseOrThrow\(\s*([A-Za-z_$][\w$]*)\s*,\s*(?:request\.query|query)|validateQuery\(\s*([A-Za-z_$][\w$]*)\s*\)|parseOrThrow\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{[^{}]*request\.query/g;
const READS_ROWS = /\.findMany\s*\(|\.groupBy\s*\(|\$queryRaw|\$queryRawUnsafe/;
const HOUSE_CURSOR = /encodeListCursor|pageOf\s*\(/;
const RATE_LIMITED = /consumeStorefrontRateLimit|limitStorefrontWrite|limitUpload/;

/** The handler plus one hop into everything it calls, and a second hop through helpers. */
function reachableText(body, bodies) {
  let text = body;
  const called = new Set();
  for (const match of body.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) called.add(match[1]);
  // A handler passed as a BARE IDENTIFIER is never «called» in this text. Only
  // whole-argument identifiers count — an identifier lifted out of a comment or
  // an expression would attach another route's door to this one.
  for (const argument of topLevelArguments(body)) if (/^[A-Za-z_$][\w$]*$/.test(argument)) called.add(argument);
  for (const name of called) {
    const found = bodies.get(name);
    if (found) text += "\n" + found;
  }
  const secondHop = new Set();
  for (const name of called) {
    const found = bodies.get(name);
    if (!found) continue;
    for (const match of found.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) if (!called.has(match[1])) secondHop.add(match[1]);
  }
  for (const name of secondHop) {
    const found = bodies.get(name);
    if (found) text += "\n" + found;
  }
  return text;
}

/**
 * The TOP-LEVEL keys of a `response.status(N).json({ … })` literal.
 *
 * Read by balancing braces from the literal's own `{`, counting only keys at
 * depth 1 — a nested `{ store: { slug } }` must not contribute `slug`. Where the
 * body is not a literal (`response.json(await listOrders(...))`) nothing is
 * claimed, and the document says so instead of inventing a shape.
 */
function responsesFrom(body) {
  const found = new Map();
  for (const match of body.matchAll(/response\s*\.\s*status\s*\(\s*(\d{3})\s*\)\s*\.\s*json\s*\(/g)) {
    const status = Number(match[1]);
    const argumentStart = match.index + match[0].length;
    let cursor = argumentStart;
    while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1;
    const keys = body[cursor] === "{" ? topLevelKeys(body, cursor) : null;
    const existing = found.get(status);
    if (!existing) found.set(status, keys);
    else if (keys && existing) for (const key of keys) existing.add(key);
  }
  // `response.sendStatus(204)` and the image streams answer without `.json(`.
  for (const match of body.matchAll(/response\s*\.\s*status\s*\(\s*(\d{3})\s*\)\s*\.\s*(?:send|end|type)\s*\(/g)) {
    if (!found.has(Number(match[1]))) found.set(Number(match[1]), null);
  }
  return found;
}

function topLevelKeys(source, openBraceIndex) {
  const keys = new Set();
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") { i = skipString(source, i); continue; }
    if (char === "/" && source[i + 1] === "/") { const end = source.indexOf("\n", i); if (end === -1) break; i = end; continue; }
    if (char === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); if (end === -1) break; i = end + 1; continue; }
    if (char === "{" || char === "[" || char === "(") { depth += 1; continue; }
    if (char === "}" || char === "]" || char === ")") { depth -= 1; if (depth === 0) break; continue; }
    if (depth !== 1) continue;
    const rest = source.slice(i);
    const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest);
    if (key) { keys.add(key[1]); i += key[0].length - 1; continue; }
    // `{ ...page }` — the keys are wherever `page` came from. The identifier is
    // recorded so the caller can follow it one hop; if it cannot, the document
    // says the shape is not fully derivable rather than claiming it is.
    const spread = /^\.\.\.\s*(?:await\s+)?([A-Za-z_$][\w$]*)/.exec(rest);
    if (spread) { keys.add(`…${spread[1]}`); i += spread[0].length - 1; continue; }
    if (rest.startsWith("...")) keys.add("…spread");
  }
  return keys;
}

/**
 * One hop after a spread: `response.json({ storeSlug, ...page })` where
 * `const page = await listProducts(...)`.
 *
 * Without this, every paginated list in the platform documented `storeSlug` and
 * nothing else — the resource array, the thing the caller actually wants, lives
 * behind the spread. The hop is deliberately shallow and deliberately
 * OVER-inclusive: keys from every `return { … }` in the producing function are
 * merged, and nothing is marked required, so a conditional branch can add a key
 * to the document but can never make the document claim a key is guaranteed.
 */
function resolveSpread(name, routeBody, bodies) {
  const binding = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*(?:await\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`).exec(routeBody);
  const producer = bodies.get(binding?.[1] ?? name);
  if (!producer) return null;
  const keys = new Set();
  for (const match of producer.matchAll(/return\s*\{/g)) {
    for (const key of topLevelKeys(producer, match.index + match[0].length - 1)) {
      if (!key.startsWith("…")) keys.add(key);
    }
  }
  return keys.size ? keys : null;
}

// ---------------------------------------------------------------------------
// 7. Building the document.
// ---------------------------------------------------------------------------

/**
 * One route that answers a 4xx by writing the body BY HAND instead of throwing
 * an `HttpError` — so its response carries a `validation` key as a SIBLING of
 * `error` rather than inside it, and no generated description can be derived
 * from the throw sites like every other error on the platform.
 *
 * It is described here rather than silently normalised because moving the key
 * inside `error` (which `HttpError`'s `details` would do) is a WIRE CHANGE to a
 * screen this phase does not own: the CSV import UI reads `payload.validation`.
 * 20-2 left this open and it stays open — but it is now written down in the one
 * place an integrator will look, and the guard fails if a SECOND route grows a
 * hand-written error body. The list may only shrink.
 */
const HAND_WRITTEN_ERROR_BODIES = {
  "POST /merchant/stores/:storeSlug/catalog/import/products": {
    reason: "20-2 debt: the CSV import answers 422 with `validation` as a sibling of `error`, not inside it. Normalising it would change the wire shape the import screen already reads.",
    extraProperties: {
      validation: {
        type: "object",
        description: "معاينة الاستيراد المرفوض: عدد الصفوف، الجديد منها، والأخطاء صفاً صفاً. مفتاح شقيق لـ `error` — وهو استثناء موثَّق، لا قاعدة.",
        properties: {
          totalRows: { type: "integer" },
          newProducts: { type: "integer" },
          newVariants: { type: "integer" },
          errors: { type: "array", items: { type: "object" } },
        },
      },
    },
  },
};

/**
 * `:objectKey(*)` is a real path in this codebase — an S3 object key, which
 * contains slashes, so the route gives the parameter its own Express pattern.
 * OpenAPI has no way to say «this parameter eats the rest of the path», so the
 * pattern is stripped from the TEMPLATE (`{objectKey}` is the only legal form)
 * and stated in the parameter's description instead, where it is true and
 * visible rather than silently dropped.
 */
function expressPathToOpenApi(expressPath) {
  return expressPath.replace(/:([A-Za-z_$][\w$]*)(?:\([^)]*\))?/g, "{$1}");
}

function pathParametersOf(expressPath) {
  return [...expressPath.matchAll(/:([A-Za-z_$][\w$]*)(\([^)]*\))?/g)].map((match) => ({ name: match[1], pattern: match[2] }));
}

function operationIdOf(method, expressPath) {
  const segments = expressPath.split("/").filter(Boolean).map((segment) =>
    segment.startsWith(":") ? `By${segment.slice(1)[0].toUpperCase()}${segment.slice(2)}` : segment.replace(/[^A-Za-z0-9]+(.)?/g, (_all, next) => (next ? next.toUpperCase() : "")),
  );
  const joined = segments.map((segment, index) => (index === 0 ? segment : segment[0].toUpperCase() + segment.slice(1))).join("");
  return `${method.toLowerCase()}${joined[0].toUpperCase()}${joined.slice(1)}`;
}

export async function buildOpenApiDocument() {
  // --- the authority for paths and methods: the router the server will use ---
  const { createApp } = await import(new URL(`file://${APP_FILE.replace(/\\/g, "/")}`).href);
  const app = createApp();
  const router = app._router ?? app.router;
  if (!router?.stack) throw new Error("could not read the Express routing table — the introspection this generator depends on has moved");
  const runtime = new Set();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    // The `app.all("*")` 404 net is not an endpoint; it is what answers when
    // none matched, and it is documented once, as the default response.
    if (layer.route.path === "*") continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (method === "_all") continue;
      runtime.add(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }

  // --- the metadata: a static reading of the same routes ---
  const bodies = new Map();
  const indexed = [
    ...allTsFiles(path.join(SRC, "services")),
    ...allTsFiles(path.join(SRC, "auth")),
    ...routeSourceFiles(),
    ...allTsFiles(path.join(SRC, "modules")),
    path.join(SRC, "http", "shared.ts"),
  ];
  for (const file of indexed) {
    const source = readFileSync(file, "utf8");
    indexFunctions(source, bodies);
    indexConstInitializers(source, bodies);
  }

  const staticRoutes = new Map();
  const sourceFiles = [APP_FILE, ...routeSourceFiles()];
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    // A module's routes are tagged by the module id, not «routes».
    const tag = file.includes(`${path.sep}modules${path.sep}`) ? path.basename(path.dirname(file)) : path.basename(file, ".ts");
    const schemaImports = schemaImportsOf(source, file);
    for (const registration of routeRegistrations(source)) {
      const key = `${registration.method} ${registration.expressPath}`;
      if (staticRoutes.has(key)) throw new Error(`two registrations of ${key} — Express would silently use the first`);
      staticRoutes.set(key, { ...registration, schemaImports, tag: file === APP_FILE ? "service" : tag, file: path.relative(REPO, file).replace(/\\/g, "/") });
    }
  }

  crossCheck(runtime, staticRoutes);
  checkHandWrittenErrorBodies(staticRoutes);

  const schemas = await loadSchemaModules();
  const errorCatalogue = buildErrorCatalogue();
  const usedSchemas = new Map();
  const paths = {};
  const tags = new Set();

  for (const key of [...staticRoutes.keys()].sort()) {
    const route = staticRoutes.get(key);
    const openApiPath = expressPathToOpenApi(route.expressPath);
    const reachable = reachableText(route.body, bodies);
    const identity = identityOf(reachable);
    const bodySchemaLocal = firstCapture(route.body, BODY_SCHEMA);
    const querySchemaLocal = firstCapture(route.body, QUERY_SCHEMA);
    // Through the route file's own import, never by bare name — see loadSchemaModules.
    const bodySchemaName = bodySchemaLocal ? route.schemaImports.get(bodySchemaLocal) ?? bodySchemaLocal : undefined;
    const querySchemaName = querySchemaLocal ? route.schemaImports.get(querySchemaLocal) ?? querySchemaLocal : undefined;
    const isList = READS_ROWS.test(reachable) && reachable.includes("nextCursor");
    const usesHouseCursor = isList && HOUSE_CURSOR.test(reachable);
    const rateLimited = RATE_LIMITED.test(reachable);
    const multipart = /\.single\(|\.array\(|multer/.test(route.body);
    const responses = responsesFrom(route.body);
    tags.add(route.tag);

    for (const name of [bodySchemaName, querySchemaName]) {
      if (!name) continue;
      const found = schemas.get(name);
      // A schema the route names but no schema module exports is a broken
      // reading, not a route without validation. Fail rather than under-report.
      if (!found) throw new Error(`${key} validates with «${name}», which no module in src/http/schemas exports`);
      if (!usedSchemas.has(name)) usedSchemas.set(name, toJsonSchema(found, name));
    }

    const operation = {
      operationId: operationIdOf(route.method, route.expressPath),
      tags: [route.tag],
      summary: `${route.method} ${openApiPath}`,
      description: describeOperation({ identity, rateLimited, isList, usesHouseCursor, multipart, route }),
      parameters: buildParameters(route, querySchemaName, usedSchemas, isList),
      responses: buildResponses({ key, responses, isList, identity, bodySchemaName, rateLimited, reachable, routeBody: route.body, bodies }),
      "x-codiq-identity": identity.kinds.length ? identity.kinds : ["public"],
      "x-codiq-source": route.file,
    };
    if (identity.permissions.length) operation["x-codiq-permissions"] = identity.permissions;
    if (CONDITIONAL_ROUTES[key]) {
      operation["x-codiq-conditional"] = CONDITIONAL_ROUTES[key].condition;
      operation.description += `\n\n**غير مسجَّل دائماً** (\`${CONDITIONAL_ROUTES[key].condition}\`): ${CONDITIONAL_ROUTES[key].note}`;
    }
    if (isList) operation["x-codiq-list-envelope"] = true;
    if (rateLimited) operation["x-codiq-rate-limited"] = true;
    if (identity.kinds.length) operation.security = securityFor(identity.kinds);
    else operation.security = [];
    if (bodySchemaName) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${bodySchemaName}` } } },
      };
    } else if (multipart) {
      operation.requestBody = {
        required: true,
        content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" }, files: { type: "array", items: { type: "string", format: "binary" } } }, description: "رفع متعدد الأجزاء عبر multer — الحقل والسقف مذكوران في وصف العملية." } } },
      };
    }

    paths[openApiPath] ??= {};
    // المرحلة 20-4: the public storefront is NOT versioned. Stated per path item
    // rather than in prose, so a generated client cannot get it wrong.
    if (isStorefrontPath(route.expressPath)) {
      paths[openApiPath].servers = [{ url: "/api", description: "المسار الوحيد لواجهة المتجر العام — غير مُصدَّرة بنسخة عمداً." }];
    }
    paths[openApiPath][route.method.toLowerCase()] = operation;
  }

  const document = {
    openapi: "3.1.0",
    info: {
      title: "CODIQ — واجهة المنصة",
      version: "1.0.0",
      summary: "وثيقة مولّدة آلياً من جدول التوجيه الفعلي ومن مخططات zod. لا تُحرَّر بخط اليد.",
      // The OPERATION count, not the routing table's: the two differ by the
      // flag-gated demo route, and «تصف 227» beside 228 documented operations
      // is the small kind of wrong that makes a reader distrust the large kind.
      description: documentDescription(staticRoutes.size),
      license: { name: "MIT" },
    },
    servers: [
      { url: "/api/v1", description: "البادئة المُصدَّرة بنسخة — استخدمها لكل تكامل جديد. لا تشمل واجهة المتجر العام." },
      { url: "/api", description: "البادئة الأصلية. باقية بلا موعد إزالة، وهي المسار الوحيد لواجهة المتجر العام (\u200E/api/store/*\u200E)." },
    ],
    tags: [...tags].sort().map((name) => ({ name })),
    security: [],
    components: {
      securitySchemes: {
        // D-63: الاسم مكتوبٌ هنا حرفياً ولا يُقرأ من `WEB_SESSION_COOKIE`، لأنّ
        // ذاك يتبع `Secure` فيصير اسماً في بيئة التطوير وآخر في الإنتاج —
        // ووثيقةٌ تتغيّر بحسب من ولّدها يكسر الحارس الذي يوازنها بالمودعة. هذا
        // هو اسم المنصّة المنشورة؛ التطوير المحلّي على http وحده يستعمل الاسم
        // العاري `codiq_session`.
        sessionCookie: { type: "apiKey", in: "cookie", name: "__Host-codiq_session", description: "جلسة لوحة التحكم. المسار `/` — تُرسَل إلى البادئتين معاً. بادئة `__Host-` تمنع أيّ نطاقٍ فرعيّ من كتابتها." },
        bearerSession: { type: "http", scheme: "bearer", description: "نفس رمز الجلسة في ترويسة Authorization. تُقبل حيثما تُقبل الكعكة." },
        customerCookie: { type: "apiKey", in: "cookie", name: "codiq_customer_session_{storeSlug}", description: "جلسة زبون المتجر. مقصورة على المسار `/api/store/{storeSlug}` — ولهذا لا تُصدَّر واجهة المتجر بنسخة." },
      },
      parameters: {
        ListLimit: { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 25 }, description: "حجم الصفحة. خارج النطاق ⇒ `400 INVALID_LIMIT` — لا قصٌّ صامت." },
        ListCursor: { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 512 }, description: "مؤشر معتم من `nextCursor` في الصفحة السابقة. مؤشر قائمة أخرى ⇒ `400`." },
      },
      schemas: {
        ErrorEnvelope: errorEnvelopeSchema(errorCatalogue),
        ValidationFailed: validationFailedSchema(),
        ListEnvelope: listEnvelopeSchema(),
        ...Object.fromEntries([...usedSchemas.entries()].sort(([a], [b]) => a.localeCompare(b))),
      },
      responses: sharedErrorResponses(),
    },
    paths,
    "x-codiq-error-catalogue": Object.fromEntries(
      [...errorCatalogue.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, entry]) => [code, {
        statuses: [...entry.statuses].sort((a, b) => a - b),
        messages: [...entry.messages].filter(Boolean).sort(),
      }]),
    ),
    "x-codiq-generated": {
      by: "phase1-backend/scripts/generate-openapi.mjs",
      from: ["the Express routing table of createApp()", "the zod schemas in src/http/schemas", "every new HttpError(...) throw site in src"],
      // TWO NUMBERS, because they are not the same number and one of them alone
      // would be quietly wrong. The routing table of an ordinary environment
      // does not carry the flag-gated demo route, but the document describes it
      // (marked `x-codiq-conditional`) because it is a real endpoint somewhere.
      routesInRoutingTable: runtime.size,
      operations: [...staticRoutes.keys()].length,
      note: "مولّدة آلياً — أي تحرير يدوي يسقط في أول تشغيل لـ `pnpm openapi:guard`.",
    },
  };

  return document;
}

function firstCapture(text, pattern) {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function isStorefrontPath(expressPath) {
  return expressPath === "/store" || expressPath.startsWith("/store/");
}

/**
 * Both directions, and both are load-bearing.
 *
 * A route in the router that the scan missed would be an endpoint MISSING from
 * the document — the failure the acceptance gate («وثيقة OpenAPI تغطي كل
 * endpoints») is about. A route in the sources that the router does not have is
 * a registration behind a flag, a dead line, or a scan that read a comment as
 * code — and documenting an endpoint that does not answer is the other half of
 * the same lie.
 */
function crossCheck(runtime, staticRoutes) {
  const missingFromScan = [...runtime].filter((key) => !staticRoutes.has(key)).sort();
  const missingFromRouter = [...staticRoutes.keys()].filter((key) => !runtime.has(key) && !CONDITIONAL_ROUTES[key]).sort();
  // An entry that silences nothing is a stale entry, and an allowlist nobody
  // prunes stops meaning anything — the same rule `csrf-origin.guard.mjs` and
  // `list-envelope.guard.mjs` apply to theirs.
  const staleConditional = Object.keys(CONDITIONAL_ROUTES)
    .filter((key) => !staticRoutes.has(key) || runtime.has(key))
    .sort();
  if (!missingFromScan.length && !missingFromRouter.length && !staleConditional.length) return;
  const lines = [];
  if (staleConditional.length) {
    lines.push(`${staleConditional.length} CONDITIONAL_ROUTES entry/entries no longer describe a conditional route:`);
    for (const key of staleConditional) lines.push(`    · ${key} — ${runtime.has(key) ? "the router registers it unconditionally now" : "no longer in the sources"}. Delete the entry.`);
  }
  if (missingFromScan.length) {
    lines.push(`${missingFromScan.length} route(s) the Express router registers and the source scan did not see:`);
    for (const key of missingFromScan) lines.push(`    · ${key}`);
    lines.push("  The scan is what supplies auth, schemas and errors; a route it cannot see would be documented as a bare path or not at all.");
  }
  if (missingFromRouter.length) {
    lines.push(`${missingFromRouter.length} route(s) the source scan found that the router does NOT register:`);
    for (const key of missingFromRouter) lines.push(`    · ${key}`);
    lines.push("  Registered behind a flag, dead, or misread. Documenting an endpoint that does not answer is the same lie in the other direction.");
  }
  throw new Error(`the routing table and the source scan disagree — nothing was written.\n\n  ${lines.join("\n  ")}\n`);
}

/**
 * A ratchet, not a note. The list above may only SHRINK.
 *
 * The rule: a route refuses by THROWING an `HttpError`, so the refusal travels
 * through one handler, gets one envelope, one correlation id and one log line.
 * Exactly one route writes its 4xx body by hand, and the consequence is visible
 * in the document — a `validation` key sitting beside `error` instead of inside
 * it, describable only because someone wrote the shape down here.
 *
 * Without this check, that entry would be a comment claiming a guarantee it did
 * not provide, which is the failure mode the whole phase is about. With it, the
 * second route to grow a hand-written error body cannot be added quietly: it
 * either gets its shape written down or it does not merge.
 */
function checkHandWrittenErrorBodies(staticRoutes) {
  const HAND_WRITTEN = /response\s*\.\s*status\s*\(\s*[45]\d{2}\s*\)\s*\.\s*json\s*\(/;
  const found = [...staticRoutes.entries()].filter(([, route]) => HAND_WRITTEN.test(route.body)).map(([key]) => key);
  const undeclared = found.filter((key) => !HAND_WRITTEN_ERROR_BODIES[key]).sort();
  const stale = Object.keys(HAND_WRITTEN_ERROR_BODIES).filter((key) => !found.includes(key)).sort();
  if (!undeclared.length && !stale.length) return;
  const lines = [];
  if (undeclared.length) {
    lines.push(`${undeclared.length} route(s) write a 4xx/5xx body by hand instead of throwing an HttpError:`);
    for (const key of undeclared) lines.push(`    · ${key}`);
    lines.push("  Throw `new HttpError(status, CODE, message, details)` so the refusal rides the same envelope, correlation id and log line as every other failure — or, if the wire shape genuinely cannot change, add it to HAND_WRITTEN_ERROR_BODIES with its schema and a written reason so the document describes what it actually sends.");
  }
  if (stale.length) {
    lines.push(`${stale.length} HAND_WRITTEN_ERROR_BODIES entry/entries silence nothing any more — delete them:`);
    for (const key of stale) lines.push(`    · ${key}`);
  }
  throw new Error(`hand-written error bodies — nothing was written.\n\n  ${lines.join("\n  ")}\n`);
}

function securityFor(kinds) {
  if (kinds.includes("customer")) return [{ customerCookie: [] }, { bearerSession: [] }];
  return [{ sessionCookie: [] }, { bearerSession: [] }];
}

function describeOperation({ identity, rateLimited, isList, usesHouseCursor, multipart, route }) {
  const lines = [];
  lines.push(identity.kinds.length
    ? `**الباب**: ${identity.kinds.join(" أو ")}.`
    : "**الباب**: مفتوح بلا جلسة.");
  if (identity.permissions.length) lines.push(`**الصلاحية**: \`${identity.permissions.join("` و `")}\`.`);
  if (isList) {
    lines.push(usesHouseCursor
      ? "**قائمة**: تُجيب بمَغلَّف المرحلة 20-2 — `{ <resource>: T[], nextCursor, …facets }` مع مؤشر معتم واحد."
      : "**قائمة**: تُجيب بمَغلَّف المرحلة 20-2، ومؤشرها لا يمرّ عبر `services/list-page.ts` (مُدرَجة في `list-envelope.legacy.json` بسبب مكتوب).");
  }
  if (rateLimited) lines.push("**سقف**: محكومة بعدّاد `storefront_rate_limits` — التجاوز `429 RATE_LIMITED`. المفتاح (نطاق، صاحب الطلب)، لا المسار: البادئتان تتقاسمان دلواً واحداً.");
  if (multipart) lines.push("**رفع**: `multipart/form-data` عبر multer، والتحقق من الهوية يسبق قراءة أول بايت.");
  if (isStorefrontPath(route.expressPath)) lines.push("**غير مُصدَّرة بنسخة**: `/api` فقط. كعكة الزبون مقصورة على `/api/store/{storeSlug}`، فالبادئة المُصدَّرة تُبطلها.");
  return lines.join("\n\n");
}

function buildParameters(route, querySchemaName, usedSchemas, isList) {
  const parameters = pathParametersOf(route.expressPath).map(({ name, pattern }) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    ...(pattern ? { description: `يلتقط بقية المسار (نمط Express \`${pattern}\`)، فقد يحتوي على \`/\` — وهو ما لا يمكن لقالب OpenAPI التعبير عنه.`, allowReserved: true } : {}),
  }));
  const seen = new Set(parameters.map((parameter) => parameter.name));
  if (querySchemaName) {
    const schema = usedSchemas.get(querySchemaName);
    for (const [name, property] of Object.entries(schema?.properties ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      parameters.push({ name, in: "query", required: (schema.required ?? []).includes(name), schema: property });
    }
  }
  // The pagination pair is read straight off `request.query` on the routes that
  // predate `list.schema.ts`. They are still real parameters, so they are still
  // documented — from the shared component, which is where their rules live.
  if (isList) {
    if (!seen.has("limit")) { parameters.push({ $ref: "#/components/parameters/ListLimit" }); seen.add("limit"); }
    if (!seen.has("cursor")) { parameters.push({ $ref: "#/components/parameters/ListCursor" }); seen.add("cursor"); }
  }
  for (const match of route.body.matchAll(/request\.query(?:\.([A-Za-z_$][\w$]*)|\[\s*"([^"]+)"\s*\])/g)) {
    const name = match[1] ?? match[2];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    parameters.push({ name, in: "query", required: false, schema: { type: "string" }, description: "يُقرأ من `request.query` مباشرة — لا مخطط zod يصفه بعد، فالنوع هنا هو ما يصل على السلك." });
  }
  return parameters;
}

function buildResponses({ key, responses, isList, identity, bodySchemaName, rateLimited, reachable, routeBody, bodies }) {
  const out = {};
  const successStatuses = [...responses.keys()].filter((status) => status < 400).sort((a, b) => a - b);
  for (const status of successStatuses.length ? successStatuses : [200]) {
    const rawKeys = responses.get(status);
    let keys = rawKeys;
    const unresolvedSpreads = [];
    if (rawKeys) {
      keys = new Set();
      for (const key of rawKeys) {
        if (!key.startsWith("…")) { keys.add(key); continue; }
        const name = key.slice(1);
        const resolved = name === "spread" ? null : resolveSpread(name, routeBody, bodies);
        if (resolved) for (const inner of resolved) keys.add(inner);
        else unresolvedSpreads.push(name === "spread" ? "…" : name);
      }
    }
    out[String(status)] = {
      description: keys ? "استجابة ناجحة." : "استجابة ناجحة — الجسم يُركِّبه الخدمةُ نفسها، فمفاتيحه غير مقروءة من المسار.",
      content: { "application/json": { schema: successSchema(keys, isList, unresolvedSpreads) } },
    };
  }
  const errorStatuses = [...responses.keys()].filter((status) => status >= 400);

  // Every code the handler — or anything it calls one hop away — can throw,
  // grouped by the status it carries in the catalogue.
  const thrown = new Map();
  for (const match of reachable.matchAll(/new HttpError\(\s*(\d{3})\s*,\s*"([A-Z0-9_]+)"/g)) {
    const status = Number(match[1]);
    if (!thrown.has(status)) thrown.set(status, new Set());
    thrown.get(status).add(match[2]);
  }
  // …and the codes a route writes by hand rather than throwing.
  for (const match of routeBody.matchAll(/response\s*\.\s*status\s*\(\s*(\d{3})\s*\)\s*\.\s*json\s*\(\s*\{\s*error:\s*\{\s*code:\s*"([A-Z0-9_]+)"/g)) {
    const status = Number(match[1]);
    if (!thrown.has(status)) thrown.set(status, new Set());
    thrown.get(status).add(match[2]);
  }
  for (const status of errorStatuses) if (!thrown.has(status)) thrown.set(status, new Set());
  if (bodySchemaName) {
    if (!thrown.has(422)) thrown.set(422, new Set());
    thrown.get(422).add("VALIDATION_FAILED");
    // `express.json` refuses a malformed or oversize body before the route runs,
    // so EVERY body-taking route can answer these two. They were being lost on
    // the forty routes that throw a 400 of their own: the `??=` fallback to the
    // shared `MalformedBody` response only fires when nothing else claimed 400,
    // so a route with an `INVALID_EMAIL` documented a 400 that named one cause
    // and hid the other. A partial list of causes reads as a complete one.
    if (!thrown.has(400)) thrown.set(400, new Set());
    thrown.get(400).add("INVALID_JSON_BODY");
    if (!thrown.has(413)) thrown.set(413, new Set());
    thrown.get(413).add("REQUEST_BODY_TOO_LARGE");
  }
  if (rateLimited) { if (!thrown.has(429)) thrown.set(429, new Set()); thrown.get(429).add("RATE_LIMITED"); }
  if (identity.kinds.length) {
    if (!thrown.has(401)) thrown.set(401, new Set());
    thrown.get(401).add(identity.kinds.includes("customer") ? "CUSTOMER_SESSION_REQUIRED" : "MISSING_SESSION");
  }

  for (const [status, codes] of [...thrown.entries()].sort(([a], [b]) => a - b)) {
    const listed = [...codes].sort();
    out[String(status)] = {
      description: listed.length ? `\`${listed.join("` · `")}\`` : "خطأ في هذا الطلب.",
      content: { "application/json": { schema: errorSchemaFor(key, status, listed) } },
    };
    // The CODES only. Their Arabic messages live once, in
    // `x-codiq-error-catalogue`; repeating them under two hundred operations
    // would be a second copy of the contract, and a second copy is a thing that
    // can disagree with the first.
    if (listed.length) out[String(status)]["x-codiq-error-codes"] = listed;
  }

  // The three every route on the platform can answer, from the shared handler.
  out["400"] ??= { $ref: "#/components/responses/MalformedBody" };
  out["413"] ??= { $ref: "#/components/responses/BodyTooLarge" };
  out["500"] = { $ref: "#/components/responses/InternalError" };
  out.default = { $ref: "#/components/responses/Error" };
  return out;
}

function errorSchemaFor(key, status, codes) {
  const handWritten = HAND_WRITTEN_ERROR_BODIES[key];
  const base = { $ref: "#/components/schemas/ErrorEnvelope" };
  if (status === 422 && codes.includes("VALIDATION_FAILED")) {
    return handWritten
      ? { allOf: [{ $ref: "#/components/schemas/ValidationFailed" }, { type: "object", properties: handWritten.extraProperties, description: handWritten.reason }] }
      : { $ref: "#/components/schemas/ValidationFailed" };
  }
  if (handWritten && status >= 400) {
    return { allOf: [base, { type: "object", properties: handWritten.extraProperties, description: handWritten.reason }] };
  }
  return base;
}

/**
 * NOTHING IS MARKED REQUIRED.
 *
 * The keys are read from the response literal, which proves a key CAN appear —
 * `...(condition ? { hint } : {})` is real in this codebase — and proves nothing
 * about whether it always does. A generated `required` would be a confident
 * claim derived from evidence that does not support it, which is the whole
 * failure this document exists to avoid. `nextCursor` is the exception and it
 * is required by `ListEnvelope`, where 20-2 actually guarantees it.
 */
function successSchema(keys, isList, unresolvedSpreads) {
  if (!keys) {
    const opaque = { type: "object", description: "الجسم من تركيب الخدمة — غير مشتق من المسار، فلا يُدَّعى له شكل هنا." };
    // A list route whose route line hands the service's return straight through
    // (`response.json(await listSettlements(...))`) still answers the 20-2
    // envelope — that contract is enforced by `list:guard`, not by this line.
    // Dropping the reference here because the KEYS were not readable would make
    // the document say less than the platform actually guarantees.
    return isList ? { allOf: [{ $ref: "#/components/schemas/ListEnvelope" }, opaque] } : opaque;
  }
  const properties = {};
  for (const key of keys) {
    if (key.startsWith("…")) continue;
    if (key === "nextCursor") { properties[key] = { type: ["string", "null"], description: "`null` تعني أن هذه كانت الصفحة الأخيرة. لا `hasMore` بجوارها يمكن أن يخالفها." }; continue; }
    if (key === "storeSlug") { properties[key] = { type: "string", description: "المتجر الذي تخص هذه القائمة — صدىً مقصود يجعل الاستجابة واصفةً لنفسها." }; continue; }
    properties[key] = {};
  }
  const shape = { type: "object", properties };
  if (unresolvedSpreads?.length) {
    shape.description = `يحمل أيضاً مفاتيح من نشرٍ (\`...${unresolvedSpreads.join("`، `...")}\`) لم يتيسّر تتبّعها من المسار — المفاتيح أعلاه مؤكَّدة، والقائمة ليست حصرية.`;
  }
  return isList ? { allOf: [{ $ref: "#/components/schemas/ListEnvelope" }, shape] } : shape;
}

function errorEnvelopeSchema(catalogue) {
  return {
    type: "object",
    required: ["error"],
    additionalProperties: false,
    description: "مغلّف الخطأ الموحّد. الرسائل عربية وهي عقد: المرحلة 22 تترجمها **بالرمز**، فالرمز هو ما يُبنى عليه، لا نصّ الرسالة.",
    properties: {
      error: {
        type: "object",
        required: ["code", "message", "requestId"],
        additionalProperties: true,
        properties: {
          code: { type: "string", enum: [...catalogue.keys()].sort(), description: "رمز ثابت. المجموعة كاملة في `x-codiq-error-catalogue`." },
          message: { type: "string", description: "رسالة للقارئ. قد تتغير صياغتها؛ الرمز لا يتغير." },
          requestId: { type: "string", pattern: "^[0-9a-f]{16}$", description: "معرّف الطلب نفسه في ترويسة `x-request-id` وفي سطر السجل — هو ما يُقتبس عند الإبلاغ عن خطأ." },
        },
      },
    },
  };
}

function validationFailedSchema() {
  return {
    allOf: [
      { $ref: "#/components/schemas/ErrorEnvelope" },
      {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { const: "VALIDATION_FAILED" },
              fields: {
                type: "array",
                description: "إضافة المرحلة 19-ج: حقلٌ حقلاً. الحقلان `code` و`message` في المغلّف لم يتغيرا، فالعملاء القدامى يرون ما كانوا يرونه.",
                items: {
                  type: "object",
                  required: ["path", "code", "message"],
                  properties: {
                    path: { type: "string", description: "مسار منقوط: `address.governorate` أو `items.0.quantity`." },
                    code: { type: "string", description: "رمز zod — `too_small`، `invalid_type`، `too_big`. مجموعة مغلقة يمكن للمترجم حصرها." },
                    message: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    ],
  };
}

function listEnvelopeSchema() {
  return {
    type: "object",
    required: ["nextCursor"],
    description: [
      "مَغلَّف القوائم الموحّد (المرحلة 20-2): `{ <resource>: T[], nextCursor, …facets }`.",
      "",
      "اسم المصفوفة هو **اسم المورد** (`products`، `orders`) لا `items`: «items» كلمة محجوزة في المجال نفسه — سطور الطلب وسطور السلة كلاهما items.",
      "`nextCursor` هو المصدر الوحيد لجواب «هل هناك صفحة ثانية»، و`null` تعني لا. لا يوجد `hasMore` بجواره يمكن أن يخالفه.",
      "المؤشر معتم دائماً: `base64url(JSON)` يحمل نسخةً ونوعَ القائمة وقيمةَ الترتيب ومعرّفَ السطر. مؤشر من قائمة أخرى يُرفض بـ `400` صريح لا بصفحة فارغة.",
    ].join("\n"),
    properties: {
      nextCursor: { type: ["string", "null"] },
    },
  };
}

function sharedErrorResponses() {
  const envelope = { content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } };
  return {
    Error: { description: "خطأ، بالمغلّف الموحّد.", ...envelope },
    MalformedBody: { description: "`INVALID_JSON_BODY` — الجسم ليس JSON صالحاً. خطأ المُرسِل، لا خطأ الخادم.", ...envelope },
    BodyTooLarge: { description: "`REQUEST_BODY_TOO_LARGE` — تجاوز سقف المحلّل (1 ميغابايت).", ...envelope },
    InternalError: { description: "`INTERNAL_ERROR` — عطل يملكه الخادم. مُسجَّل بسطر واحد يحمل `requestId` نفسه.", ...envelope },
  };
}

function documentDescription(routeCount) {
  return [
    "## وثيقة مولّدة، لا مكتوبة",
    "",
    `هذه الوثيقة تصف ${routeCount} مسار endpoint، وكلُّ حقيقةٍ فيها مقروءة من الشيفرة التي تعمل:`,
    "",
    "- **المسارات والأفعال** من جدول توجيه Express الذي يبنيه `createApp()` — لا من قائمة تُحدَّث باليد.",
    "- **أشكال الطلب** من مخططات zod في `src/http/schemas/` عبر `z.toJSONSchema` من zod نفسها.",
    "- **الباب المطلوب** من الحارس الذي يستدعيه المعالج، ومعه رمز الصلاحية إن وُجد.",
    "- **رموز الأخطاء** من كل موضع `new HttpError(...)` في الواجهة الخلفية.",
    "",
    "ولأن قراءتين مستقلتين للشيفرة يجب أن تتطابقا قبل أن يُكتب أي شيء، فإن مساراً يعرفه الموجِّه ولا يراه الماسح — أو العكس — يُسقِط التوليد بدل أن يُنتج وثيقةً ناقصة بهدوء.",
    "",
    "## بابان، تطبيق واحد",
    "",
    "`/api/v1` و`/api` هما **الكائن نفسه** مركَّباً على مسارين. لا فرق بينهما في أي استجابة، ولا دلو سقفٍ ثانٍ: مفتاح السقف هو (النطاق، صاحب الطلب) ولا يدخل فيه المسار.",
    "",
    "**استثناء واحد ودائم**: واجهة المتجر العام `\u200E/api/store/*\u200E` لا تُصدَّر بنسخة. كعكة جلسة الزبون مقصورة على المسار `/api/store/{storeSlug}`، فالدخول عبر البادئة المُصدَّرة يمنح الزبون كعكةً يرفض متصفحه إعادتها إلى العنوان نفسه — يدخل ثم يصير مجهولاً في الطلب التالي، و200 على كليهما. لذلك `\u200E/api/v1/store/*\u200E` يُرفض بـ 404 صريحة.",
    "",
    "## مسار غير معروف",
    "",
    "أي مسار تحت البادئتين لا يطابق شيئاً هنا يُجيب `404 RESOURCE_NOT_FOUND` — بالمغلّف نفسه وبمعرّف الطلب نفسه، لا بصفحة HTML. هذا مقصود: قبل المرحلة 20-2 كان يسقط إلى الصدفة ويُجيب `200 text/html`، فيقرأه العميل نجاحاً ويسلّم `null`، وتظهر النتيجة شاشةً فارغة بعد أيام و200 في كل سجل.",
    "",
    "## الأخطاء عقد",
    "",
    "الرسائل عربية وهي جزء من العقد: المرحلة 22 تترجمها **بالرمز**. ابنِ على `error.code`، لا على نص `error.message`. المجموعة كاملة في `x-codiq-error-catalogue`، وكل استجابة خطأ هنا تُسمّي الرموز التي يمكن أن تصل منها.",
    "",
    "## القوائم",
    "",
    "كل قائمة تُجيب بمَغلَّف `ListEnvelope` نفسه — موصوف مرة واحدة ومُشار إليه — بمؤشر معتم واحد. لا تبنِ مؤشراً بيدك: الوثيقة تصفه سلسلةً معتمة لأنه كذلك.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 8. Emitting.
// ---------------------------------------------------------------------------

export function renderJson(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The served copy.
 *
 * A TypeScript module rather than a `readFile` of the JSON at boot: the composite
 * server is bundled by esbuild into `dist/index.js` and run from there, so a
 * relative read of `docs/openapi.json` would work in development and answer 500
 * in production the first time a deploy shipped `dist` without the repo beside
 * it. A module is bundled with the code that imports it and cannot go missing.
 */
export function renderTs(document) {
  return [
    "/**",
    " * GENERATED FILE — لا تحرّره بخط اليد.",
    " *",
    " * Written by `pnpm openapi:generate` from the Express routing table and the",
    " * zod schemas. `pnpm openapi:guard` regenerates it and fails on any",
    " * difference, so a hand edit survives exactly until the next CI run.",
    " *",
    " * ONE LINE, NOT PRETTY-PRINTED. The reviewable copy is `docs/openapi.json`,",
    " * which is where a diff should be read; this one is bundled into",
    " * `dist/index.js` and only ever parsed by a machine, so the indentation",
    " * would be half a megabyte of whitespace shipped to production.",
    " *",
    " * Typed through an index signature on purpose: the document is data, and a",
    " * deep literal type over two hundred path items would cost",
    " * `pnpm phase1:typecheck` real seconds to infer a type nothing reads.",
    " */",
    "export interface OpenApiDocument {",
    "  readonly [key: string]: unknown;",
    "}",
    "",
    `export const openApiDocument: OpenApiDocument = ${JSON.stringify(document)};`,
    "",
  ].join("\n");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const document = await buildOpenApiDocument();
  writeFileSync(JSON_OUTPUT, renderJson(document), "utf8");
  writeFileSync(TS_OUTPUT, renderTs(document), "utf8");
  const operations = Object.values(document.paths).reduce((total, item) => total + Object.keys(item).filter((key) => key !== "servers").length, 0);
  console.log(JSON.stringify({
    generator: "openapi",
    status: "written",
    summary: {
      operations,
      pathItems: Object.keys(document.paths).length,
      schemas: Object.keys(document.components.schemas).length,
      errorCodes: Object.keys(document["x-codiq-error-catalogue"]).length,
      json: path.relative(REPO, JSON_OUTPUT).replace(/\\/g, "/"),
      module: path.relative(REPO, TS_OUTPUT).replace(/\\/g, "/"),
    },
  }, null, 2));
  process.exit(0);
}
