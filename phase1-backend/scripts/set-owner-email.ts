/**
 * PC-1 — set a platform owner's SIGN-IN email from the command line.
 *
 * WHY THIS EXISTS WHEN A BUTTON ALREADY DOES IT. The button
 * («لوحة المالك ← حسابي ومعلومات التواصل ← الأمان») is the intended path and the
 * one to use. This script is for the single case the button cannot serve: the
 * owner cannot SIGN IN — his old address is unreachable, or he is standing up a
 * restored database — and therefore cannot reach the form that would fix it.
 *
 * WHAT IT WILL NOT DO:
 *   · It never touches `password_hash`. The owner said «و لا حاجة لتغيير كلمة
 *     السر», and a maintenance script that quietly reset a password would be the
 *     one operation nobody would think to check for afterwards.
 *   · It never CREATES an owner. If the `--from` address does not exist it says
 *     so and exits non-zero, rather than minting a second platform owner because
 *     of a typo.
 *   · It hardcodes no address. Both come from the command line, so this file
 *     stays true when the owner changes his mind next year.
 *
 * IT IS IDEMPOTENT. Run twice and the second run reports «already set» and exits
 * 0, so it is safe inside a deploy step or a runbook someone re-reads and re-runs.
 *
 * THE DATABASE STILL DECIDES. `codiq_guard_owner_merchant_staff_email` refuses an
 * address already held by a merchant, store staff or platform staff, and that
 * refusal is reported here as the conflict it is rather than as a stack trace.
 *
 * Run:
 *   pnpm owner:email -- --from old@example.com --to new@example.com
 *   pnpm owner:email -- --id 8f2c…  --to new@example.com   (when the old address is unknown)
 *   pnpm owner:email -- --list                              (show the owner rows)
 */
import { normalizeEmail } from "../src/auth/identity.js";
import { prisma } from "../src/db/prisma.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--"))
    return process.argv[index + 1];
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

async function main() {
  if (process.argv.includes("--list")) {
    const owners = await prisma.platformOwner.findMany({
      select: { id: true, email: true, displayName: true, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    console.log(JSON.stringify({ owners }, null, 2));
    return;
  }

  const to = flag("to");
  const from = flag("from");
  const id = flag("id");
  if (!to || (!from && !id)) {
    console.error(
      "Usage: pnpm owner:email -- --to <new@example.com> (--from <old@example.com> | --id <uuid>)\n       pnpm owner:email -- --list"
    );
    process.exitCode = 1;
    return;
  }

  // Normalized through the SAME function the HTTP route uses, so a script run and
  // a form submission cannot store two different spellings of one address.
  const target = normalizeEmail(to);
  const owner = id
    ? await prisma.platformOwner.findUnique({ where: { id }, select: { id: true, email: true } })
    : await prisma.platformOwner.findUnique({
        where: { email: normalizeEmail(from) },
        select: { id: true, email: true },
      });

  if (!owner) {
    console.error(
      `No platform owner matches ${id ? `id ${id}` : `email ${from}`}. Nothing was written. Run with --list to see the owner rows.`
    );
    process.exitCode = 1;
    return;
  }
  if (owner.email === target) {
    console.log(
      JSON.stringify({ status: "already_set", ownerId: owner.id, email: target }, null, 2)
    );
    return;
  }

  try {
    // `data` names ONE column. The password hash, the display name, TOTP and the
    // sessions are all left exactly as they were — he stays signed in and keeps
    // the password he already has.
    await prisma.platformOwner.update({ where: { id: owner.id }, data: { email: target } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("CODIQ_EMAIL_CONFLICT") || message.includes("Unique constraint")) {
      console.error(
        `${target} already belongs to another identity on the platform (owner, platform staff, merchant, or store staff). Nothing was written.`
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  console.log(
    JSON.stringify(
      {
        status: "changed",
        ownerId: owner.id,
        from: owner.email,
        to: target,
        passwordChanged: false,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error("set-owner-email failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
