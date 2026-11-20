/**
 * ق-251 (المرحلة 29-3) — the configuration registry and its one resolver, as a unit test.
 *
 *   1. THE REGISTRY IS CLOSED AND CONSISTENT: codes are unique, every plan feature
 *      it names is one entitlement knows, and the `merchant_settings` CHECK in the
 *      migration names EXACTLY the codes the registry lets a merchant hold — a new
 *      merchant-level setting cannot be added on one side alone.
 *   2. THE RULES: cap = the smallest value any level set; allow = true only while
 *      every level that spoke said true; pref = the most specific level wins;
 *      nothing set = the default. The level order never depends on input order,
 *      and a level the definition does not admit is ignored.
 *   3. VALUES ARE TYPED: a boolean setting refuses a string, an integer refuses a
 *      float and honours its bounds; an unknown code is refused by name.
 *
 * Run: pnpm config:unit
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { SETTINGS, SETTING_CODES, resolveFromLevels, settingDefinition, registryInvariants, parseSettingValue, CONFIG_LEVELS } = await import("../src/services/config.service.ts");

// ── 1. registry ↔ migration CHECK ↔ entitlement ──────────────────────────────
const { merchantCodes, planFeatures } = registryInvariants();
const sql = readFileSync(new URL("../../prisma/migrations/20260916150000_q251_config_hierarchy/migration.sql", import.meta.url), "utf8");
const checkList = sql.match(/CONSTRAINT merchant_settings_code CHECK \(code IN \(([^)]*)\)\)/)[1].match(/'([^']+)'/g).map((code) => code.slice(1, -1)).sort();
assert.deepEqual(checkList, [...merchantCodes].sort(), "merchant_settings CHECK names exactly the registry codes the merchant may hold");
assert.ok(planFeatures.length >= 5, "the plan speaks through entitlement's features");
assert.equal(new Set(SETTING_CODES).size, SETTINGS.length);
for (const setting of SETTINGS) assert.ok(setting.levels.includes("platform"), `${setting.code}: the platform always has a say`);
assert.deepEqual([...CONFIG_LEVELS], ["platform", "plan", "merchant", "store", "customer"], "the order of 01 §14");

// ── 2. the rules ─────────────────────────────────────────────────────────────
const cap = settingDefinition("marketing.daily_cap");
const r = (definition, levels) => { const out = resolveFromLevels(definition, levels); return [out.value, out.source]; };
assert.deepEqual(r(cap, []), [200, "default"], "nothing set → the default");
assert.deepEqual(r(cap, [{ level: "platform", value: 100 }, { level: "merchant", value: 150 }, { level: "store", value: 50 }]), [50, "store"], "cap: the tightest level decides");
assert.deepEqual(r(cap, [{ level: "store", value: 150 }, { level: "platform", value: 100 }]), [100, "platform"], "cap: a store cannot loosen the platform's ceiling, whatever order the levels arrive in");
assert.deepEqual(r(cap, [{ level: "merchant", value: 100 }, { level: "store", value: 100 }]), [100, "merchant"], "cap: on a tie the higher level is named");
const stores = settingDefinition("stores.max");
assert.deepEqual(r(stores, [{ level: "plan", value: 30 }]), [30, "plan"], "cap: the plan's limit");
assert.deepEqual(r(stores, [{ level: "plan", value: 30 }, { level: "store", value: 1 }]), [30, "plan"], "cap: a level the definition does not admit is ignored");
assert.deepEqual(r(stores, [{ level: "platform", value: 10 }, { level: "plan", value: 30 }]), [10, "platform"], "cap: the platform's hard maximum sits above every plan");
const allow = settingDefinition("checkout.guest_allowed");
assert.deepEqual(r(allow, []), [true, "default"]);
assert.deepEqual(r(allow, [{ level: "platform", value: true }, { level: "merchant", value: true }, { level: "store", value: true }]), [true, "store"], "allow: everyone said yes → the most specific yes");
assert.deepEqual(r(allow, [{ level: "store", value: true }, { level: "platform", value: false }]), [false, "platform"], "allow: a store cannot open what the platform closed");
assert.deepEqual(r(allow, [{ level: "merchant", value: false }, { level: "store", value: true }]), [false, "merchant"], "allow: nor what the merchant closed");
assert.deepEqual(r(allow, [{ level: "customer", value: true }]), [true, "default"], "allow: the customer has no say here");
const pref = settingDefinition("marketing.opt_in");
assert.deepEqual(r(pref, [{ level: "platform", value: true }, { level: "customer", value: false }]), [false, "customer"], "pref: the customer's word is the last");
assert.deepEqual(r(pref, [{ level: "customer", value: false }, { level: "platform", value: true }]), [false, "customer"], "pref: … in whatever order");
assert.deepEqual(r(pref, [{ level: "platform", value: false }]), [false, "platform"]);
const chain = resolveFromLevels(cap, [{ level: "store", value: 50 }, { level: "platform", value: 100 }]).chain;
assert.deepEqual(chain.map((entry) => entry.level), ["platform", "store"], "the chain is reported in level order");

// ── 3. typed values ──────────────────────────────────────────────────────────
assert.equal(parseSettingValue(allow, false), false);
assert.throws(() => parseSettingValue(allow, "yes"), (error) => error.code === "INVALID_SETTING_VALUE");
assert.equal(parseSettingValue(cap, 0), 0);
assert.throws(() => parseSettingValue(cap, 1.5), (error) => error.code === "INVALID_SETTING_VALUE");
assert.throws(() => parseSettingValue(cap, -1), (error) => error.code === "INVALID_SETTING_VALUE");
assert.throws(() => parseSettingValue(cap, 100_001), (error) => error.code === "INVALID_SETTING_VALUE");
assert.throws(() => settingDefinition("config.free_form_key"), (error) => error.code === "UNKNOWN_SETTING" && error.status === 422, "no free key/value — the registry is closed");

console.log(JSON.stringify({ suite: "config-unit", status: "passed", settings: SETTINGS.length, merchantCodes, planFeatures }, null, 2));
