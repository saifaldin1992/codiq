/**
 * The review's report, written from git — every commit, every file, every
 * changed line range — so nothing done in a batch can be left out of it
 * (owner's request, 2026-11-22: a report of every deletion, change and fix,
 * per line, for every completed batch).
 *
 *   node tools/review-report.mjs --from <rev> --to <rev> --title "…"
 *     --out docs/review/….md [--ast-proof]
 *
 * For each commit: its hash, date and message; for each file: added, changed,
 * deleted or renamed, lines added and removed, and the line ranges (before →
 * after). A commit of up to DETAIL_LIMIT changed lines is printed in full,
 * before and after. A bigger one (a formatting pass) is summarised per file,
 * and `--ast-proof` adds, for every commit whose title says it formats, per changed
 * TypeScript/JavaScript file, the proof that its syntax tree is the same before and
 * after (see tools/ast-same.mjs) — which is what «no behaviour changed» means there.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { sameSyntax } from "./ast-same.mjs";

const DETAIL_LIMIT = 400;
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const from = arg("--from");
const to = arg("--to") ?? "HEAD";
const title = arg("--title") ?? "تقرير الدفعة";
const out = arg("--out");
const astProof = process.argv.includes("--ast-proof");
if (!from || !out) {
  console.error("usage: --from <rev> --to <rev> --title … --out <file> [--ast-proof]");
  process.exit(2);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
const show = (rev, path) => {
  try {
    return git("show", `${rev}:${path}`);
  } catch {
    return null;
  }
};
const KIND = { A: "أُضيف", M: "عُدّل", D: "حُذف", R: "أُعيدت تسميته" };
const digits = (n) => n.toLocaleString("ar-IQ");

const commits = git("rev-list", "--reverse", `${from}..${to}`).trim().split("\n").filter(Boolean);
const lines = [`# ${title}`, ""];
const totals = { commits: commits.length, files: new Set(), added: 0, removed: 0 };
const sections = [];
for (const hash of commits) {
  const [date, subject, ...body] = git(
    "show",
    "-s",
    "--format=%ad%n%s%n%b",
    "--date=short",
    hash
  ).split("\n");
  const message = body.filter((line) => line && !/^(Co-Authored-By|Claude-Session):/.test(line));
  const status = git("show", "--format=", "--name-status", "-M", hash)
    .trim()
    .split("\n")
    .filter(Boolean);
  const numstat = git("show", "--format=", "--numstat", "-M", hash)
    .trim()
    .split("\n")
    .filter(Boolean);
  const changed = numstat.reduce((sum, row) => {
    const [a, d] = row.split("\t");
    return sum + (Number(a) || 0) + (Number(d) || 0);
  }, 0);
  const part = [`## ${hash.slice(0, 7)} — ${subject}`, "", `التاريخ: ${date}`, ""];
  if (message.length) part.push(...message.map((line) => `> ${line}`), "");
  part.push("| الملفّ | التغيير | أُضيف | حُذف | الأسطر (قبل ← بعد) |", "|---|---|---|---|---|");
  const proofs = [];
  // The proof is for FORMATTING commits only: a commit that changes code on purpose is
  // expected to change its syntax tree, so «0 of 1 the same» there would say nothing.
  const proveThis = astProof && /\bformat/i.test(subject);
  for (const row of status) {
    const [code, ...paths] = row.split("\t");
    const path = paths.at(-1);
    const stat = numstat.find(
      (entry) => entry.endsWith(`\t${path}`) || entry.includes(`=> ${path.split("/").pop()}`)
    );
    const [added, removed] = stat ? stat.split("\t") : ["0", "0"];
    totals.files.add(path);
    totals.added += Number(added) || 0;
    totals.removed += Number(removed) || 0;
    const hunks = git("show", "--format=", "-U0", "-M", hash, "--", ...paths)
      .split("\n")
      .filter((line) => line.startsWith("@@"))
      .map((line) => {
        // "@@ -12,3 +14,5 @@" — split, no regular expression to backtrack on.
        const [, minus = "", plus = ""] = line.split(" ");
        if (!minus.startsWith("-") || !plus.startsWith("+")) return "";
        const [a, b = "1"] = minus.slice(1).split(",");
        const [c, d = "1"] = plus.slice(1).split(",");
        const range = (start, count) =>
          Number(count) === 0
            ? "—"
            : Number(count) === 1
              ? start
              : `${start}–${Number(start) + Number(count) - 1}`;
        return `${range(a, b)} ← ${range(c, d)}`;
      })
      .filter(Boolean);
    const shown =
      hunks.length > 12
        ? `${hunks.slice(0, 12).join("، ")} … (${digits(hunks.length)} موضعاً)`
        : hunks.join("، ");
    part.push(
      `| \`${path}\` | ${KIND[code[0]] ?? code} | ${added} | ${removed} | ${shown || "—"} |`
    );
    if (proveThis && code[0] === "M" && /\.(ts|tsx|mjs|js)$/.test(path)) {
      const before = show(`${hash}^`, path);
      const after = show(hash, path);
      proofs.push({
        path,
        same: before !== null && after !== null && sameSyntax(path, before, after),
      });
    }
  }
  part.push("");
  if (proofs.length) {
    const failed = proofs.filter((proof) => !proof.same);
    part.push(
      "**إثبات أنّ المنطق لم يتغيّر:** شجرة الصياغة متطابقة قبل وبعد في " +
        `${digits(proofs.length - failed.length)} من ${digits(proofs.length)} ملفّاً.`
    );
    if (failed.length)
      part.push(
        "",
        "ملفّات تختلف شجرتها (تُراجع واحداً واحداً):",
        ...failed.map((proof) => `- \`${proof.path}\``)
      );
    part.push("");
  }
  if (changed <= DETAIL_LIMIT) {
    part.push("<details><summary>كلّ سطر تغيّر (قبل/بعد)</summary>", "");
    part.push("```diff");
    part.push(git("show", "--format=", "-U1", "-M", hash).trimEnd());
    part.push("```", "", "</details>", "");
  } else {
    part.push(
      `هذا الكومِت غيّر ${digits(changed)} سطراً — ` +
        `كلّ سطر منها: \`git show ${hash.slice(0, 7)}\`.`,
      ""
    );
  }
  sections.push(part.join("\n"));
}
lines.push(
  `**الكومِتات:** ${digits(totals.commits)} · **الملفّات:** ${digits(totals.files.size)} · ` +
    `**أسطر أُضيفت:** ${digits(totals.added)} · **أسطر حُذفت:** ${digits(totals.removed)}`,
  "",
  `المدى: \`${from.slice(0, 7)}..${to.slice(0, 7)}\` — أعيد توليده بـ ` +
    `\`node tools/review-report.mjs --from ${from.slice(0, 7)} --to ${to.slice(0, 7)} …\``,
  "",
  ...sections
);
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(JSON.stringify({ written: out, ...totals, files: totals.files.size }));
