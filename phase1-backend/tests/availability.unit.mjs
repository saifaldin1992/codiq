/**
 * المرحلة 29 (ق-249) — the precedence matrix of `effectiveState`, as a unit test.
 *
 * The resolver is pure on purpose: every row below is a fact pattern and the
 * state the specification (02 §6) demands for it. If a future edit reorders
 * two branches, the row that encodes that pair fails by name.
 *
 * Run: pnpm availability:unit
 */
import assert from "node:assert/strict";

const {
  effectiveState,
  customerMessageFor,
  CUSTOMER_MESSAGES,
  STATE_LABELS_AR,
  AVAILABILITY_STATES,
} = await import("../src/services/availability.service.ts");
const { rolloutBucket } = await import("../src/services/feature-flags.service.ts");

const base = {
  merchantActive: true,
  storeStatus: "active",
  platformOverride: null,
  merchantOverride: null,
  storeOverride: null,
  serviceState: "available",
  capabilityState: "available",
  dependencyUnavailable: false,
  flag: null,
};
const rows = [
  ["nothing restricts", {}, "AVAILABLE", "none"],
  [
    "merchant suspended beats everything, even a platform AVAILABLE override",
    { merchantActive: false, platformOverride: "AVAILABLE" },
    "MERCHANT_DISABLED",
    "merchant",
  ],
  ["store suspended", { storeStatus: "suspended" }, "STORE_DISABLED", "store"],
  ["store closed", { storeStatus: "closed" }, "STORE_DISABLED", "store"],
  [
    "store maintenance beats a platform override",
    { storeStatus: "maintenance", platformOverride: "AVAILABLE" },
    "MAINTENANCE",
    "store",
  ],
  [
    "paused (the vacation) does NOT gate capabilities — only checkout",
    { storeStatus: "paused" },
    "AVAILABLE",
    "none",
  ],
  [
    "merchant-level resolution (no store) ignores store state",
    { storeStatus: null },
    "AVAILABLE",
    "none",
  ],
  [
    "platform override wins over merchant and store overrides",
    { platformOverride: "DISABLED", merchantOverride: "AVAILABLE", storeOverride: "AVAILABLE" },
    "DISABLED",
    "platform_override",
  ],
  // ق-250: the clock and the incident desk speak after the owner's explicit override, before any merchant-level word.
  [
    "a live maintenance window closes the capability",
    { maintenanceWindow: true },
    "MAINTENANCE",
    "maintenance_window",
  ],
  [
    "a platform AVAILABLE override beats a maintenance window",
    { platformOverride: "AVAILABLE", maintenanceWindow: true },
    "AVAILABLE",
    "platform_override",
  ],
  [
    "a maintenance window beats a merchant AVAILABLE override",
    { maintenanceWindow: true, merchantOverride: "AVAILABLE" },
    "MAINTENANCE",
    "maintenance_window",
  ],
  [
    "a blocking incident closes the capability",
    { incidentBlocking: true },
    "TEMPORARILY_UNAVAILABLE",
    "incident",
  ],
  [
    "a maintenance window beats a blocking incident",
    { maintenanceWindow: true, incidentBlocking: true },
    "MAINTENANCE",
    "maintenance_window",
  ],
  [
    "store maintenance beats a blocking incident",
    { storeStatus: "maintenance", incidentBlocking: true },
    "MAINTENANCE",
    "store",
  ],
  [
    "merchant override wins over store override",
    { merchantOverride: "TEMPORARILY_UNAVAILABLE", storeOverride: "AVAILABLE" },
    "TEMPORARILY_UNAVAILABLE",
    "merchant_override",
  ],
  [
    "store override wins over defaults",
    { storeOverride: "COMING_SOON", serviceState: "disabled" },
    "COMING_SOON",
    "store_override",
  ],
  [
    "an AVAILABLE override re-enables what a default disables",
    { merchantOverride: "AVAILABLE", capabilityState: "disabled" },
    "AVAILABLE",
    "merchant_override",
  ],
  ["service coming_soon", { serviceState: "coming_soon" }, "COMING_SOON", "service"],
  [
    "service disabled beats capability available",
    { serviceState: "disabled", capabilityState: "available" },
    "DISABLED",
    "service",
  ],
  ["service deprecated", { serviceState: "deprecated" }, "DEPRECATED", "service"],
  ["service retired", { serviceState: "retired" }, "RETIRED", "service"],
  [
    "capability coming_soon (the WhatsApp seed)",
    { capabilityState: "coming_soon" },
    "COMING_SOON",
    "capability",
  ],
  ["capability disabled", { capabilityState: "disabled" }, "DISABLED", "capability"],
  [
    "dependency unavailable after defaults",
    { dependencyUnavailable: true },
    "DEPENDENCY_UNAVAILABLE",
    "dependency",
  ],
  [
    "default state beats dependency",
    { serviceState: "coming_soon", dependencyUnavailable: true },
    "COMING_SOON",
    "service",
  ],
  ["flag off holds it back as coming soon", { flag: false }, "COMING_SOON", "flag"],
  [
    "flag on opens nothing that a default closed",
    { flag: true, capabilityState: "disabled" },
    "DISABLED",
    "capability",
  ],
  ["flag on with everything open", { flag: true }, "AVAILABLE", "none"],
  [
    "dependency beats the flag",
    { dependencyUnavailable: true, flag: false },
    "DEPENDENCY_UNAVAILABLE",
    "dependency",
  ],
];
for (const [name, facts, state, source] of rows) {
  const answer = effectiveState({ ...base, ...facts });
  assert.equal(answer.state, state, `${name}: state`);
  assert.equal(answer.source, source, `${name}: source`);
}

// The customer sentences are the owner's, verbatim (01 §13).
assert.equal(customerMessageFor("COMING_SOON"), CUSTOMER_MESSAGES.COMING_SOON.ar);
assert.equal(CUSTOMER_MESSAGES.COMING_SOON.ar, "الخدمة ستتاح قريبًا.");
assert.equal(CUSTOMER_MESSAGES.MAINTENANCE.ar, "الخدمة تحت الصيانة.");
assert.equal(CUSTOMER_MESSAGES.STORE_MAINTENANCE.ar, "المتجر مغلق للصيانة.");
assert.equal(customerMessageFor("MAINTENANCE"), CUSTOMER_MESSAGES.MAINTENANCE.ar);
assert.equal(customerMessageFor("DISABLED"), CUSTOMER_MESSAGES.UNAVAILABLE.ar);
for (const state of AVAILABILITY_STATES)
  assert.ok(STATE_LABELS_AR[state], `every state has a merchant label: ${state}`);

// A rollout bucket is stable and inside 0..99, so a 20% rollout is the same 20% every request.
const bucket = rolloutBucket("11111111-1111-4111-8111-111111111111");
assert.equal(bucket, rolloutBucket("11111111-1111-4111-8111-111111111111"));
assert.ok(bucket >= 0 && bucket < 100);
const spread = new Set(Array.from({ length: 200 }, (_, i) => rolloutBucket(`merchant-${i}`)));
assert.ok(spread.size > 50, `200 merchants spread over many buckets, not a few: ${spread.size}`);

console.log(
  JSON.stringify(
    {
      suite: "availability-unit",
      status: "passed",
      rows: rows.length,
      labels: AVAILABILITY_STATES.length,
    },
    null,
    2
  )
);

// ── ق-250: the pure clock and pickers of maintenance.service / incidents.service ──
// ق-169: no calendar date is written down — every instant is derived from Date.now().
const { windowPhase, pickWindowFor, formatBaghdad } = await import(
  "../src/services/maintenance.service.ts"
);
const { pickIncidentFor } = await import("../src/services/incidents.service.ts");
const HOUR = 3_600_000;
const t0 = new Date(Date.now() + 40 * 24 * HOUR);
const at = (hours) => new Date(t0.valueOf() + hours * HOUR);
const win = (over) => ({
  id: "w",
  scope: "platform",
  serviceId: null,
  capabilityId: null,
  merchantId: null,
  storeId: null,
  affects: [],
  messageAr: "m",
  endsAt: at(2),
  ...over,
});
assert.equal(windowPhase({ status: "scheduled", startsAt: at(1), endsAt: at(2) }, t0), "upcoming");
assert.equal(
  windowPhase({ status: "scheduled", startsAt: t0, endsAt: at(2) }, t0),
  "active",
  "the start instant is inside the window"
);
assert.equal(
  windowPhase({ status: "scheduled", startsAt: at(-24), endsAt: t0 }, t0),
  "ended",
  "the end instant is outside it"
);
assert.equal(windowPhase({ status: "cancelled", startsAt: t0, endsAt: at(2) }, t0), "cancelled");
assert.equal(
  windowPhase({ status: "completed", startsAt: t0, endsAt: at(26) }, t0),
  "ended",
  "a stamped window reads ended whatever the clock says"
);
const subject = {
  serviceId: "s1",
  serviceCode: "delivery",
  capabilityId: "c1",
  capabilityCode: "delivery.manifest",
};
assert.equal(pickWindowFor([], subject), null);
assert.equal(
  pickWindowFor([win({ affects: ["pos.sell"] })], subject),
  null,
  "a narrowed platform window misses what it does not name"
);
assert.equal(
  pickWindowFor([win({ affects: ["delivery"] })], subject)?.id,
  "w",
  "naming the service covers its capabilities"
);
assert.equal(
  pickWindowFor(
    [
      win({ id: "svc", scope: "service", serviceId: "s1" }),
      win({ id: "cap", scope: "capability", capabilityId: "c1" }),
    ],
    subject
  )?.id,
  "svc",
  "the wider scope answers first"
);
assert.equal(
  pickWindowFor([win({ id: "other", scope: "capability", capabilityId: "c9" })], subject),
  null
);
assert.equal(
  pickWindowFor([win({ id: "store", scope: "store", storeId: "st1" })], subject)?.id,
  "store"
);
const inc = (over) => ({
  id: "i",
  title: "t",
  publicMessage: "p",
  severity: "minor",
  status: "investigating",
  affects: [],
  blocks: false,
  ...over,
});
assert.equal(pickIncidentFor([inc({ affects: ["pos"] })], subject), null);
assert.equal(
  pickIncidentFor(
    [inc({ id: "notice" }), inc({ id: "block", blocks: true, affects: ["delivery.manifest"] })],
    subject
  )?.id,
  "block",
  "a blocking incident is picked over a notice"
);
assert.equal(pickIncidentFor([inc({ id: "notice" })], subject)?.id, "notice");
// Baghdad has been UTC+3 with no daylight saving since 2008, so plain arithmetic is an independent oracle for Intl.
const baghdadByArithmetic = (date) =>
  new Date(date.valueOf() + 3 * HOUR).toISOString().slice(0, 16).replace("T", " ");
assert.equal(formatBaghdad(t0), baghdadByArithmetic(t0));
const lateEvening = new Date(t0);
lateEvening.setUTCHours(21, 30, 0, 0);
assert.equal(
  formatBaghdad(lateEvening),
  baghdadByArithmetic(lateEvening),
  "21:30 UTC is 00:30 in Baghdad — written 00, never 24"
);
assert.match(formatBaghdad(lateEvening), / 00:30$/);
console.log(
  JSON.stringify({
    status: "passed",
    clock: "windowPhase/pickWindowFor/pickIncidentFor/formatBaghdad",
  })
);
