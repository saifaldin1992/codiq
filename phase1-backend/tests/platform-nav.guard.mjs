/**
 * ق-170 — a platform permission is a door, and every door has a screen.
 *
 * ============================================================================
 * WHAT WAS BROKEN, AND WHY IT WAS STRUCTURAL
 * ============================================================================
 *
 * The server's matrix carries nine permission codes. The staff shell's
 * navigation was written BY HAND with eleven entries, and nothing compared the
 * two. So three codes existed with no screen behind them:
 *
 *   overview.view   granted to all three roles; the home page showed it as a
 *                   chip and drew nothing behind it.
 *   brand.manage    grantable from the team screen as «إدارة هوية المنصة»;
 *                   the routes answered 200 to the supervisor; no link existed.
 *   audit.view      same — the only caller lived inside the OWNER shell,
 *                   which ق-143 makes his alone.
 *
 * A staff member saw his permissions as text on his home page and could open
 * none of them. The owner could grant a permission that did nothing. Every
 * server test was green, because the server was not the broken part.
 *
 * The audit that found this counted platform staff as the identity worst hit,
 * and named the cause: two lists, hand-maintained, never reconciled. This file
 * is the reconciliation, run on every push.
 *
 * ============================================================================
 * WHAT IS ASSERTED
 * ============================================================================
 *
 *   1. Every code in PLATFORM_PERMISSION_CODES is the `permission` of at least
 *      one navigation entry — or is exempted HERE, with its reason, because it
 *      is an act inside a screen rather than a screen.
 *   2. Every navigation entry with a segment has a branch in the shell that
 *      renders it. An entry without a branch is exactly the old defect from
 *      the other side: a link that lands on the denial card.
 *   3. Every `can("…")` the shell checks is a real code — a typo there hides a
 *      screen from everyone, silently.
 *
 * Run: pnpm platform:nav
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const read = (file) => readFileSync(fileURLToPath(new URL(file, repoRoot)), "utf8");

/**
 * Codes that are ACTS, not screens. Each carries its reason, because an
 * exemption without one is how the next gap gets waved through.
 */
const ACTS_NOT_SCREENS = {
  // ق-249: the overrides TAB of the services screen — the entry carries services.manage,
  // and a supervisor holds both; a staff member with only this code reaches the same screen.
  "availability.manage": "an act inside «الخدمات والإتاحة» (the overrides tab), which the services.manage entry opens",
  "finance.settle": "a button inside «المالية» — the screen itself is gated by finance.view, settling is what an accountant does on it",
};

// ── the server's matrix ──────────────────────────────────────────────────────
const permissions = read("phase1-backend/src/auth/platform-permissions.ts");
const matrixBlock = permissions.slice(permissions.indexOf("PLATFORM_PERMISSION_CODES = ["), permissions.indexOf("] as const"));
const codes = Array.from(matrixBlock.matchAll(/"([a-z]+\.[a-z]+)"/g), (m) => m[1]);
assert.ok(codes.length >= 9, `expected the full matrix, read ${codes.length} codes`);

// ── the shell's navigation DATA ──────────────────────────────────────────────
const navigation = read("client/src/config/platform-staff-navigation.ts");
const entries = Array.from(
  navigation.matchAll(/\{\s*id:\s*"([^"]+)".*?segment:\s*"([^"]*)".*?permission:\s*(null|"([a-z]+\.[a-z]+)")/gs),
  (m) => ({ id: m[1], segment: m[2], permission: m[4] ?? null }),
);
assert.ok(entries.length >= 11, `expected the navigation entries, read ${entries.length}`);
const navPermissions = new Set(entries.map((e) => e.permission).filter(Boolean));

// ── the shell itself ─────────────────────────────────────────────────────────
const shell = read("client/src/pages/PlatformStaffDashboard.tsx");

// 1. every code has a door
const doorless = codes.filter((code) => !navPermissions.has(code) && !(code in ACTS_NOT_SCREENS));
assert.deepEqual(
  doorless,
  [],
  `صلاحيات بلا شاشة: ${doorless.join(", ")}\n\n` +
    `Each of these can be granted from the team screen and answers 200 on the server, and a staff member holding it ` +
    `can open nothing. Add a navigation entry whose \`permission\` is the code and a branch in PlatformStaffDashboard ` +
    `that renders it — or, if it is an act inside an existing screen, exempt it in ACTS_NOT_SCREENS with the reason.`,
);

// …and every exemption still names a real code, so the list cannot rot
for (const code of Object.keys(ACTS_NOT_SCREENS)) {
  assert.ok(codes.includes(code), `ACTS_NOT_SCREENS names "${code}", which the matrix no longer carries — remove the exemption`);
}

// 2. every entry has a branch
// The shell dispatches on `section === "<segment>"`; the orders entry is the
// one exception and matches a regex on the path instead.
const unrendered = entries
  .filter((e) => e.segment !== "")
  .filter((e) => !shell.includes(`section === "${e.segment}"`) && !new RegExp(`dashboard\\\\/${e.segment}`).test(shell))
  .map((e) => e.id);
assert.deepEqual(
  unrendered,
  [],
  `بنود تنقّل بلا فرعٍ يرسمها: ${unrendered.join(", ")}\n\n` +
    `A link that no branch renders lands on the denial card — the defect from the other side. Add the branch beside its siblings.`,
);

// 2b. the STORE staff shell, same rule — ق-178 closed D-84, where store_manager
// held two codes with no entry behind either. An entry without a branch is the
// same defect from the other side, so both lists are held to it.
const storeNav = read("client/src/config/navigation.ts");
const storeShell = read("client/src/pages/StaffDashboard.tsx");
const storeBlock = storeNav.slice(storeNav.indexOf("export const staffNavEntries"), storeNav.indexOf("];", storeNav.indexOf("export const staffNavEntries")));
const storeEntries = Array.from(storeBlock.matchAll(/\{\s*id:\s*"([^"]+)".*?segment:\s*"([^"]*)"/g), (m) => ({ id: m[1], segment: m[2] }));
assert.ok(storeEntries.length >= 8, `expected the staff navigation entries, read ${storeEntries.length}`);
const storeUnrendered = storeEntries
  .filter((e) => e.segment !== "")
  .filter((e) => !storeShell.includes(`section === "${e.segment}"`) && !new RegExp(`dashboard\\\\/${e.segment}`).test(storeShell))
  .map((e) => e.id);
assert.deepEqual(storeUnrendered, [], `بنود في تنقّل موظّف المتجر بلا فرعٍ يرسمها: ${storeUnrendered.join(", ")} — a link that lands on the denial card.`);

// 3. every `can("…")` the shell checks is a code the matrix knows
const checked = Array.from(shell.matchAll(/can\("([^"]+)"\)/g), (m) => m[1]);
const unknown = [...new Set(checked)].filter((code) => !codes.includes(code));
assert.deepEqual(unknown, [], `الصدفة تفحص رموزاً لا تعرفها المصفوفة: ${unknown.join(", ")} — a typo here hides a screen from everyone`);

console.log(JSON.stringify({
  suite: "platform-nav",
  status: "passed",
  summary: {
    codes: codes.length,
    entries: entries.length,
    screens: codes.filter((c) => navPermissions.has(c)),
    acts: Object.keys(ACTS_NOT_SCREENS),
    guarantee: "every platform permission opens a screen, every entry has a branch, every check names a real code",
  },
}, null, 2));
