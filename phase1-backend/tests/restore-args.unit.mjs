/**
 * ق-156 — the recovery tool's command line, and the two ways it failed a real
 * operator inside one minute.
 *
 * Both were found while verifying an ACTUAL production backup, not by reading:
 *
 *  1. `pnpm backup:restore -- --key latest …` — the form npm requires and
 *     muscle memory types — exited 1 with «[restore] unknown argument «--».».
 *     The documented form omits the separator and works, but a tool reached for
 *     on the worst day of the year should not punish the habit every other
 *     script in this repository teaches.
 *
 *  2. Importing this module RAN A RESTORE. `main()` was called at the bottom
 *     unconditionally, so the act of writing this very test would have fetched
 *     production ciphertext, decrypted it, and — with a target in the
 *     environment — dropped and recreated its tables. The identical omission
 *     was found in `create-first-owner.ts`; there the accident creates a row,
 *     here it destroys a database.
 *
 * What is NOT loosened: an unknown flag still throws. Silently ignoring
 * `--taget` would restore to whatever the environment happened to name, which
 * is the one mistake this tool must never make quietly.
 *
 * Run: pnpm restore:args
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/restore-database.ts", import.meta.url));
const source = readFileSync(scriptPath, "utf8");

// The import itself is assertion 2: if the guard were missing, loading this
// module would start a restore rather than return a function.
const { parseArguments } = await import("../scripts/restore-database.ts");
assert.ok(/invokedDirectly/.test(source), "the script must only run main() when it IS the command");
assert.ok(!/^main\(\)\.catch/m.test(source), "…and must not call main() at the top level");

// 1. The separator is accepted and carries no meaning.
const withSeparator = parseArguments(["--", "--key", "latest", "--to-file", "/tmp/x.dump"]);
assert.equal(withSeparator.key, "latest");
assert.equal(withSeparator.toFile, "/tmp/x.dump");
const withoutSeparator = parseArguments(["--key", "latest", "--to-file", "/tmp/x.dump"]);
assert.deepEqual(
  withSeparator,
  withoutSeparator,
  "both forms must parse identically — the separator changes nothing"
);

// A separator in the middle is equally meaningless and equally accepted.
assert.deepEqual(
  parseArguments(["--key", "latest", "--", "--to-file", "/tmp/x.dump"]),
  withoutSeparator
);

// 2. Strictness is KEPT where it protects the database.
assert.throws(
  () => parseArguments(["--key", "latest", "--taget", "postgres://x/y"]),
  /unknown argument/,
  "a misspelled flag must still stop the run — ignoring it would restore somewhere else"
);
assert.throws(
  () => parseArguments([]),
  /--key <objectKey\|latest> or --from-file/,
  "a restore with no source is refused"
);
assert.throws(
  () => parseArguments(["--key", "latest", "--from-file", "/tmp/a"]),
  /exclusive/,
  "two sources are refused"
);
assert.throws(() => parseArguments(["--key"]), /needs a value/, "a flag with no value is refused");
assert.throws(
  () => parseArguments(["--key", "--to-file"]),
  /needs a value/,
  "…and a following flag is not mistaken for a value"
);

// 3. The destructive path still demands the database name out loud.
const destructive = parseArguments([
  "--key",
  "latest",
  "--target",
  "postgres://u:p@h/db",
  "--confirm-overwrite",
  "db",
]);
assert.equal(
  destructive.confirmOverwrite,
  "db",
  "the confirmation is carried through to where the comparison happens"
);

console.log(
  JSON.stringify(
    {
      suite: "restore-args",
      status: "passed",
      summary: {
        separatorAccepted: "`--` is ignored wherever it appears",
        strictnessKept:
          "unknown flags, missing sources, double sources and valueless flags all still throw",
        importIsSafe: "importing the module runs nothing",
      },
    },
    null,
    2
  )
);
