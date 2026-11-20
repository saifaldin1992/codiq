/**
 * codiq — the guard that makes mirroring the password policy safe.
 *
 * `client/src/lib/password-strength.ts` MIRRORS
 * `phase1-backend/src/auth/password-policy.ts`, because the backend's tsconfig
 * covers only its own `src` and cannot import from `shared/`. The convention is
 * the established one — `navigation.ts` mirrors the server's permission codes
 * the same way.
 *
 * Mirrors drift. When this one drifts the failure is nasty and quiet: the bar
 * under the field reads «قوية» and the server answers with a red error about a
 * rule the meter never mentioned, and the person is left distrusting both.
 *
 * So the copy is not left to vigilance. This reads BOTH files and fails if they
 * have stopped agreeing — on the list, on the minimum, on the maximum, and on
 * every structural rule. A mirror with a guard is a copy that cannot rot.
 *
 * It parses the SOURCE TEXT rather than importing, deliberately: importing the
 * client module would need the browser bundler's path aliases, and comparing the
 * text is what actually catches an edit to one file and not the other.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const SERVER = path.join(root, "phase1-backend", "src", "auth", "password-policy.ts");
const CLIENT = path.join(root, "client", "src", "lib", "password-strength.ts");

const server = readFileSync(SERVER, "utf8");
const client = readFileSync(CLIENT, "utf8");

/** Every double-quoted entry inside a named block, in order. */
function entriesOf(source, marker, file) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${file}: cannot find «${marker}» — did the block get renamed?`);
  // Searched AFTER the marker, not from its start: the client declares
  // `COMMON_PASSWORDS: string[]`, whose own brackets sit inside the marker text
  // and were the first thing this found.
  const open = source.indexOf("[", start + marker.length);
  assert.notEqual(open, -1, `${file}: «${marker}» has no array literal after it`);
  // The closing bracket is found by COUNTING, not by searching for a token: the
  // server writes `new Set([...])` and the client writes `[...]`, so any fixed
  // terminator matches one and runs past the end of the other — which is how
  // this guard first "found" half the file as list entries.
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "[") depth += 1;
    else if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  assert.ok(close > open, `${file}: «${marker}» has no balanced closing bracket`);
  return (
    source
      .slice(open, close)
      // Line comments inside the list must not contribute entries. Built with
      // `new RegExp` rather than a literal so this file carries no escape
      // sequences at all — two of them were silently mangled writing it.
      .replace(new RegExp("//.*", "g"), "")
      .match(/"([^"]*)"/g)
      ?.map((quoted) => quoted.slice(1, -1)) ?? []
  );
}

function numberOf(source, name, file) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  assert.ok(match, `${file}: cannot find ${name}`);
  return Number(match[1]);
}

// ---------------------------------------------------------------- the list
const serverList = entriesOf(server, "const COMMON_PASSWORDS = new Set(", "server");
const clientList = entriesOf(client, "export const COMMON_PASSWORDS: string[] =", "client");

assert.ok(serverList.length > 100, `the server list looks truncated (${serverList.length} entries) — parse failure?`);

const onlyServer = serverList.filter((entry) => !clientList.includes(entry));
const onlyClient = clientList.filter((entry) => !serverList.includes(entry));
assert.deepEqual(
  onlyServer,
  [],
  `these are refused by the server but the meter would call them fine: ${onlyServer.join(", ")}`,
);
assert.deepEqual(
  onlyClient,
  [],
  `the meter refuses these but the server accepts them — it would block a usable password: ${onlyClient.join(", ")}`,
);
assert.equal(clientList.length, serverList.length, "the two lists differ in length");

// ---------------------------------------------------------------- the numbers
for (const name of ["PASSWORD_MIN_LENGTH", "PASSWORD_MAX_LENGTH"]) {
  assert.equal(
    numberOf(client, name, "client"),
    numberOf(server, name, "server"),
    `${name} differs between the meter and the policy`,
  );
}

// ---------------------------------------------------------------- the rules
//
// Names, not bodies: a rule that exists on one side and not the other is the
// drift that matters, and comparing bodies would fail on a comment.
for (const rule of ["deLeet", "isSingleCharacter", "isSequentialRun", "isRepeatedPattern"]) {
  assert.ok(server.includes(`function ${rule}(`), `server lost ${rule}`);
  assert.ok(client.includes(`function ${rule}(`), `the meter is missing ${rule} — it would score a refused password as fine`);
}

// The digit wrap is easy to add on one side only, and «1234567890» is common
// enough that missing it on either side is a real hole.
for (const [name, source] of [["server", server], ["client", client]]) {
  assert.ok(source.includes("% 10"), `${name}: the digit-run WRAP is gone — «1234567890» would pass`);
}

// The normalisation closure: the round count must match, or one side stops
// catching «Adm1n123» while the other still refuses it.
const rounds = (source) => Number(source.match(/round\s*<\s*(\d+)/)?.[1]);
assert.equal(rounds(client), rounds(server), "the normalisation runs a different number of rounds on each side");

// ---------------------------------------------------------------- behaviour
//
// The strongest check of the three, and the reason this file is worth having:
// the two implementations are RUN against the same corpus and must agree on
// every one. The text comparisons above catch an edited constant; this catches
// an edited RULE, which is the drift that would actually reach a person as
// «the bar said قوية and the server said no».
const { assertPasswordAcceptable } = await import("../src/auth/password-policy.ts");
const { assessPassword } = await import("../../client/src/lib/password-strength.ts");

const CORPUS = [
  // refused
  "password", "PASSWORD", "P@ssw0rd", "12345678", "1234567890", "123456789012",
  "Adm1n123", "admin2026", "alnoor123", "codiq123", "baghdad123", "aaaaaaaaaaaa",
  "abcdefgh", "87654321", "abcabcabcabc", "qwerty123", "bismillah", "short", "s9Kd2mQ",
  // accepted
  "shrt1abc", "burtuqal-jamil", "burtuqal-jamil-2026", "MatjarAlNoor!47",
  "correcthorsebattery", "T4jir-Baghdad-88", "zaytoun.wa.laymoon", "29471638",
  "khamsatun", "acegikmoq", "K7M2PQR4TV9XZBN", "شجرة الرمان في بيت جدي",
];

const disagreements = [];
for (const candidate of CORPUS) {
  let serverAccepts = true;
  try {
    assertPasswordAcceptable(candidate);
  } catch {
    serverAccepts = false;
  }
  const meterAccepts = assessPassword(candidate).accepted;
  if (serverAccepts !== meterAccepts) {
    disagreements.push(`«${candidate}» — server ${serverAccepts ? "accepts" : "refuses"}, meter ${meterAccepts ? "accepts" : "refuses"}`);
  }
}
assert.deepEqual(disagreements, [], `the meter and the server disagree:${disagreements.join("; ")}`);

// …and the corpus must actually contain both outcomes, or the loop above proves
// nothing: two implementations that refuse everything also never disagree.
const accepted = CORPUS.filter((candidate) => assessPassword(candidate).accepted).length;
assert.ok(accepted >= 10, `the corpus has only ${accepted} accepted entries — it is not exercising the accept path`);
assert.ok(CORPUS.length - accepted >= 10, "the corpus is not exercising the refuse path");

console.log(
  JSON.stringify(
    { passwordMirror: { entries: serverList.length, minimum: numberOf(server, "PASSWORD_MIN_LENGTH", "server"), rulesChecked: 4, corpusChecked: CORPUS.length, accepted, inSync: true } },
    null,
    2,
  ),
);
console.log("password:mirror OK");
