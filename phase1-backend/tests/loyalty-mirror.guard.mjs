/**
 * ق-166 — the merchant's loyalty screen mirrors four server constants, and the
 * mirror is COMPARED rather than trusted.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ============================================================================
 *
 * While writing that screen I copied the award cap as 100. It is 1000. Nothing
 * would have failed: the client would simply have refused, in Arabic and with
 * confidence, a perfectly legal configuration — and the merchant would have had
 * no way to discover that the platform he pays for was wrong rather than him.
 *
 * That is the ق-162 defect exactly, one screen over: a repeated list that
 * nobody compares. The client cannot import the server module (its tsconfig
 * does not reach that tree, and `prisma` would come with it), so the constants
 * are repeated — and repetition is only safe when something checks it.
 *
 * ============================================================================
 * WHAT IS AND IS NOT ASSERTED
 * ============================================================================
 *
 * The four bounds must match. The SERVER stays the authority on every one of
 * them — it re-checks the pair that would result even for a PUT carrying a
 * single field — so this guard is not what makes the platform safe. It is what
 * keeps the merchant from being told a rule that is not the rule.
 *
 * Run: pnpm loyalty:mirror
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const read = (file) => readFileSync(fileURLToPath(new URL(file, repoRoot)), "utf8");

/** `NAME = 123` → 123, from a file of plain constant declarations. */
function constant(source, name, file) {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`));
  assert.ok(
    match,
    `${name} not found in ${file} — if it was renamed, rename it here too rather than dropping the check`
  );
  return Number(match[1]);
}

const service = read("phase1-backend/src/services/loyalty.service.ts");
const screen = read("client/src/components/LoyaltySettingsCard.tsx");

const PAIRS = [
  { server: "LOYALTY_EARN_PER_1000_MAX", client: "EARN_MAX", what: "أقصى نقاط عن كل ١٠٠٠ دينار" },
  { server: "LOYALTY_POINT_VALUE_MIN", client: "POINT_VALUE_MIN", what: "أدنى قيمة للنقطة" },
  { server: "LOYALTY_POINT_VALUE_MAX", client: "POINT_VALUE_MAX", what: "أقصى قيمة للنقطة" },
  {
    server: "LOYALTY_MAX_AWARD_IQD_PER_1000",
    client: "MAX_AWARD_IQD_PER_1000",
    what: "سقف ما يُمنح عن كل ١٠٠٠ دينار",
  },
];

const drifted = [];
const compared = {};
for (const { server, client, what } of PAIRS) {
  const onServer = constant(service, server, "loyalty.service.ts");
  const onScreen = constant(screen, client, "LoyaltySettingsCard.tsx");
  compared[client] = onScreen;
  if (onServer !== onScreen) drifted.push(`${what}: الخادم ${onServer}، والشاشة ${onScreen}`);
}

assert.deepEqual(
  drifted,
  [],
  `مرآة حدود برنامج النقاط انحرفت عن الخادم:\n  ${drifted.join("\n  ")}\n\n` +
    `The server is the authority and will refuse correctly either way. The damage is on screen: the merchant is ` +
    `told a rule that is not the rule — refused a legal setting, or invited into one the server will reject.`
);

// The screen must actually be reachable. A card nobody can open is the defect
// this whole decision exists to close, and it would otherwise pass silently.
const navigation = read("client/src/config/navigation.ts");
// The merchant screens are mounted from the screen registry, not from MerchantDashboard.tsx itself.
const dashboard = read("client/src/dashboard/merchant-screens.tsx");
assert.ok(
  navigation.includes("/merchant/dashboard/settings/loyalty"),
  "the loyalty screen must have a navigation entry — CD-5 shipped everything except one"
);
assert.ok(dashboard.includes("LoyaltySettingsCard"), "…and the dashboard must actually mount it");

console.log(
  JSON.stringify(
    {
      suite: "loyalty-mirror",
      status: "passed",
      summary: {
        compared,
        reachable: "/merchant/dashboard/settings/loyalty",
        guarantee: "the screen states the server's own bounds, and a merchant can open it",
      },
    },
    null,
    2
  )
);
