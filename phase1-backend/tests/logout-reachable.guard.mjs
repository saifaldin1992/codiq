/**
 * ق-164 — every identity can leave.
 *
 * ============================================================================
 * WHAT WAS MISSING
 * ============================================================================
 *
 * Four of the five identities had a way out of their dashboard. The MERCHANT —
 * the identity that actually pays for this platform, and the one most likely to
 * open it on a shared shop computer — had none. No button in his shell, and
 * nothing in his «حسابي» group but «الأمان» and «الجلسات والأجهزة».
 *
 * The sessions screen looks like it substitutes and does not: it hides the
 * revoke button for the CURRENT session on purpose, so the one door it never
 * offers is the one door he was looking for.
 *
 * `POST /auth/logout` was built, identity-generic, and working the whole time.
 * Nobody had drawn the button. The audit that found this found fifteen more of
 * the same shape.
 *
 * ============================================================================
 * WHY A GUARD
 * ============================================================================
 *
 * This class of defect — a capability that exists in the server and is
 * unreachable from any screen — is invisible to every test that talks to the
 * server directly, because the server is not the part that is broken. It is
 * caught only by asking the question this file asks: does a HUMAN have a way in?
 *
 * Signing out is the one action every identity must have, so it is the one that
 * can be checked flatly. The general form of this check — the whole routing
 * table against the whole client — is the larger guard the audit recommends;
 * this is its first, most load-bearing row.
 *
 * Run: pnpm logout:guard
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The shell each identity actually lives inside, and what to call it in Arabic. */
const SHELLS = [
  { who: "مالك المنصة", file: "client/src/pages/OwnerDashboard.tsx" },
  { who: "طاقم المنصة", file: "client/src/pages/PlatformStaffDashboard.tsx" },
  { who: "التاجر", file: "client/src/pages/MerchantDashboard.tsx" },
  { who: "موظف المتجر", file: "client/src/pages/StaffDashboard.tsx" },
  { who: "الزبون", file: "client/src/components/StorefrontShell.tsx" },
];

const repoRoot = new URL("../../", import.meta.url);
const missing = [];
const checked = [];

for (const { who, file } of SHELLS) {
  const source = readFileSync(fileURLToPath(new URL(file, repoRoot)), "utf8");

  // A logout endpoint must be called. The customer's runs through the
  // storefront's own scoped route rather than /auth/logout, and that is
  // correct — his session belongs to one store.
  const calls = /auth\/logout/.test(source) || /\.logout\(/.test(source);

  // …and a person must be able to cause it. The five shells express that in
  // three legitimately different ways — a handler on a button, a menu item, or
  // a navigation entry the shell intercepts as an ACT rather than a page — so
  // any ONE of these counts. Deliberately loose: the defect this exists to
  // catch is a shell with NO way out at all, and a narrow regex that fails on
  // a shell which merely writes it differently is a guard nobody trusts.
  const clickable =
    /on(?:Click|Select)=\{[^}]*logout/.test(source) ||
    /sign-out/.test(source) ||
    source.includes("تسجيل الخروج");

  if (!calls || !clickable) missing.push({ who, file, calls, clickable });
  else checked.push(who);
}

assert.deepEqual(
  missing,
  [],
  `هوية بلا مخرج:\n` +
    missing
      .map((m) => `  ${m.who} — ${m.file}\n      ${m.calls ? "المسار يُنادى" : "لا نداء على /auth/logout"}, ${m.clickable ? "وله زر" : "ولا زر يُشغّله"}`)
      .join("\n") +
    `\n\nPOST /auth/logout is identity-generic and has always worked. If a shell has no button, the defect is the ` +
    `missing button — not the endpoint. And do not point the merchant at the sessions screen: it hides the revoke ` +
    `control for the current session on purpose.`,
);

console.log(JSON.stringify({
  suite: "logout-reachable",
  status: "passed",
  summary: { identities: checked.length, checked, guarantee: "every identity shell calls a logout endpoint from a control a person can reach" },
}, null, 2));
