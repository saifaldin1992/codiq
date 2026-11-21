/**
 * Guard — every write route carries the trusted-origin check (csrf:guard).
 *
 * `requireTrustedWriteOrigin` (src/http/shared.ts) refuses a write whose
 * `Origin` header names a host other than the one serving it. The session
 * cookie is `SameSite=lax`, which already blocks the classic cross-site form
 * POST, so this is the SECOND layer — and the second layer is the one that
 * still stands when the first is weakened: a sibling subdomain is same-site,
 * and a browser that mishandles SameSite is a browser we do not control.
 *
 * Why a ratchet and not a one-time fix: the convention was already the house
 * rule and 88 of 109 write routes followed it — the other 21 were not a
 * decision, they were drift. A rule that lives only in reviewers' memory
 * decays exactly like that. This file is the memory.
 *
 * ALLOWLIST entries need a written reason. An entry that silences nothing is
 * a stale entry and fails too — an allowlist nobody prunes stops meaning
 * anything (the deleted-leak-guard idiom).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeFileLabel, routeSourceFiles } from "../source-layout.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const routesDir = resolve(here, "..", "src", "http", "routes");

/** `file.ts:METHOD /path` → why this write may skip the origin check. */
const ALLOWLIST = {
  // ق-182: machine-to-machine. Resend calls it with an Svix signature over the
  // raw body and carries no cookie, so there is no session to forge; an
  // Origin check would refuse every genuine delivery. The signature IS the
  // second layer here, and the route answers 503 rather than accept unsigned.
  "webhooks.ts:POST /webhooks/resend":
    "signed webhook from the mail provider — no browser, no cookie, Svix signature over the raw body",
  "modules/market-payments/routes.ts:POST /payments/webhooks/card":
    "signed notification from the card gateway — no browser, no cookie, HMAC-SHA256 over the raw body",
  "modules/market-partner/routes.ts:POST /partner/payment-links/complete":
    "signed report from the partner app — no browser, no cookie, HMAC-SHA256 over the raw body",
};

const WRITE = /app\.(post|put|patch|delete)\(\s*"([^"]+)"/g;

const violations = [];
const suppressed = [];

for (const fullPath of routeSourceFiles()) {
  const file = routeFileLabel(fullPath);
  const source = readFileSync(fullPath, "utf8");
  let match;
  while ((match = WRITE.exec(source))) {
    const key = `${file}:${match[1].toUpperCase()} ${match[2]}`;
    // The guard call must appear before the route's handler ends. Routes are
    // written one per statement here (single-line or block), so the window is
    // the text from this route's start to the next `app.` registration.
    const start = match.index;
    const nextRoute = source.indexOf("\n  app.", start + 1);
    const body = source.slice(start, nextRoute === -1 ? source.length : nextRoute);
    if (body.includes("requireTrustedWriteOrigin")) continue;
    if (ALLOWLIST[key]) {
      suppressed.push(key);
      continue;
    }
    violations.push(key);
  }
}

const stale = Object.keys(ALLOWLIST).filter((key) => !suppressed.includes(key));

if (violations.length > 0 || stale.length > 0) {
  console.error("csrf:guard FAILED");
  if (violations.length > 0) {
    console.error(
      `\n  مسارات كتابة بلا فحص الأصل الموثوق (${violations.length}) — أضف requireTrustedWriteOrigin(request) كأول سطر، أو مدخلاً في ALLOWLIST بسبب مكتوب:`
    );
    for (const key of violations) console.error(`    ${key}`);
  }
  if (stale.length > 0) {
    console.error(`\n  مداخل ALLOWLIST لم تُسكت شيئاً — احذفها (${stale.length}):`);
    for (const key of stale) console.error(`    ${key}`);
  }
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      suite: "csrf-origin",
      status: "passed",
      summary: { allowlisted: suppressed.length },
    },
    null,
    2
  )
);
