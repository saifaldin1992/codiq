/**
 * PC-1 — mint the FIRST platform owner on a database that has none.
 *
 * WHY THIS EXISTS. On 2026-09-05 a census of the production database answered
 * `platform_owners = 0`. That single number explains an owner who could not sign
 * in, and it quietly voided every recovery path we had written down: the
 * dashboard form needs a session, `owner:email` refuses to create and exits
 * non-zero by design, and the documented `UPDATE platform_owners … WHERE email`
 * matches nothing. Three runbooks, all correct, all assuming a row that was not
 * there. This is the missing first step.
 *
 * WHY NOT THE HTTP ROUTE. `POST /auth/platform/register` already does this, but
 * only while `CODIQ_ALLOW_OWNER_REGISTRATION=true` — which means opening
 * unauthenticated owner-creation on the public internet, doing the deed, and
 * remembering to close it. The window is the risk, and the window is unnecessary:
 * this script needs the database credential, which is a strictly higher bar than
 * an open HTTP endpoint, and it leaves nothing to close afterwards.
 *
 * THE PASSWORD IS NEVER AN ARGUMENT. It is read from the terminal with echo off.
 * A password in `--password` is in the shell history, in `ps` output, and in the
 * scrollback of whoever was watching — three copies of the one secret on the
 * platform that has no one above it to reset it. Passing `--password` is
 * refused, loudly, rather than honoured.
 *
 * IT REFUSES A SECOND OWNER. If any row exists it stops and points at
 * `owner:email` instead. A bootstrap tool that silently mints a duplicate owner
 * on a re-run is how a platform ends up with two people who can do anything and
 * no record of which one acted.
 *
 * THE POLICY IS NOT REIMPLEMENTED HERE. It delegates to `registerPlatformOwner`,
 * so the ق-129 password floor, the email normalisation and the
 * merchant-email conflict are the SAME code the HTTP route runs. A second
 * implementation would drift, and it would drift on the credential that owns
 * everything.
 *
 * Run (against the target database — set DATABASE_URL or CODIQ_POSTGRES_URL):
 *   pnpm owner:create -- --email codiqos.iq@gmail.com --name "اسم المالك"
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { registerPlatformOwner } from "../src/auth/auth.service.js";
import { prisma } from "../src/db/prisma.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--"))
    return process.argv[index + 1];
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

/**
 * Reads one line with echo suppressed. `readline` still needs an output stream
 * to drive its own bookkeeping, so we hand it one whose `write` drops everything
 * except the prompt we print ourselves — muting the echo without muting the
 * prompt.
 */
function readSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  let muted = false;
  const sink = Object.create(process.stdout) as NodeJS.WriteStream;
  sink.write = ((chunk: string, ...rest: unknown[]) =>
    muted ? true : process.stdout.write(chunk, ...(rest as []))) as NodeJS.WriteStream["write"];
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  muted = true;
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

/**
 * The whole decision, separated from the terminal so it can be tested without
 * one. The count is read inside the same call that creates, because "is this
 * database empty of owners" is the entire safety property.
 */
export async function createFirstOwner(input: {
  email: string;
  displayName: string;
  password: string;
}) {
  const existing = await prisma.platformOwner.count();
  if (existing > 0) {
    throw new Error(
      `OWNER_ALREADY_EXISTS: this database already has ${existing} platform owner row(s). This script only bootstraps an empty database — use \`pnpm owner:email\` to change an existing owner's address.`
    );
  }
  return registerPlatformOwner(input);
}

async function main() {
  if (
    process.argv.some((argument) => argument === "--password" || argument.startsWith("--password="))
  ) {
    console.error(
      "رُفض: كلمة السرّ لا تُمرَّر وسيطاً. الوسيط يبقى في سجلّ الأوامر وفي مخرجات ps — تُطلب من الطرفية بلا إظهار."
    );
    process.exitCode = 1;
    return;
  }

  const email = flag("email");
  const displayName = flag("name");
  if (!email || !displayName) {
    console.error(
      'Usage: pnpm owner:create -- --email <owner@example.com> --name "<display name>"'
    );
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.platformOwner.count();
  if (existing > 0) {
    console.error(
      `رُفض: القاعدة تحوي ${existing} مالكاً بالفعل. هذا السكربت للتمهيد على قاعدة فارغة وحدها — لتغيير بريد مالك قائم استعمل \`pnpm owner:email\`.`
    );
    process.exitCode = 1;
    return;
  }

  // A password typed once and mistyped once is a platform nobody can sign into,
  // recoverable only by deleting the row and starting over.
  if (!process.stdin.isTTY) {
    console.error(
      "رُفض: لا طرفية تفاعلية. كلمة السرّ تُكتب بيد المالك، ولا تُقرأ من أنبوب أو ملف."
    );
    process.exitCode = 1;
    return;
  }
  const password = await readSecret("كلمة السرّ (لا تظهر أثناء الكتابة): ");
  const again = await readSecret("أعدها للتأكيد: ");
  if (password !== again) {
    console.error("رُفض: الكلمتان غير متطابقتين. لم يُكتب شيء.");
    process.exitCode = 1;
    return;
  }

  const account = await createFirstOwner({ email, displayName, password });
  console.log(JSON.stringify({ created: account }, null, 2));
  console.log(
    "\nالخطوة التالية: سجّل الدخول من لوحة المالك وفعّل المصادقة الثنائية فوراً (ق-124)."
  );
}

// Only when this file IS the command. Importing it — which the test does, to
// exercise `createFirstOwner` without a terminal — must not run `main()`: it
// would print a usage line and set a non-zero exit code, failing a suite whose
// assertions all passed.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
