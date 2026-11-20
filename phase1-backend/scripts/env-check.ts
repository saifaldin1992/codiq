/**
 * Preflight: does this environment do what the deployment claims?
 *
 * Run it on the Railway service AFTER editing variables and BEFORE trusting the
 * deploy. A green boot is not an answer — the platform boots fine while two
 * shipped features are dead, which is exactly what was found on 2026-09-05:
 * `CODIQ_PUBLIC_BASE_URL` was unset in production, so password recovery had been
 * answering «unavailable» to every merchant since it shipped.
 *
 * Exit 0 means the configuration is complete for this environment. Exit 1 names
 * every group that is not, and what stops working because of it.
 *
 * It prints VARIABLE NAMES and verdicts. Never a value.
 */
import { pathToFileURL } from "node:url";
import { ENVIRONMENT_GROUPS, reportEnvironment } from "../src/config/environment-report.js";

function main() {
  const report = reportEnvironment();
  const lines: string[] = [];
  lines.push(`البيئة: ${report.environment}${report.deployed ? " (منشورة)" : " (تطوير — النقص مسموح)"}`);
  lines.push("");

  for (const [index, group] of report.groups.entries()) {
    const definition = ENVIRONMENT_GROUPS[index]!;
    const mark = group.verdict === "ok" ? "✓" : group.verdict === "incomplete" ? "✗" : report.deployed && definition.requiredInDeployment ? "✗" : "·";
    lines.push(`${mark} ${group.key} — ${group.verdict}`);
    if (group.verdict !== "ok") {
      lines.push(`    الناقص: ${group.missing.join("، ")}`);
      lines.push(`    الأثر: ${group.consequence}`);
      // The distinction the whole file turns on, said at the moment it matters.
      if (group.verdict === "incomplete") lines.push("    نصفُ ضبطٍ ليس قراراً — هذا تحريرٌ لم يكتمل، وهو الشكل الذي يقلع نظيفاً ويفشل عند الاستعمال.");
    }
  }

  lines.push("");
  lines.push(report.ok ? "النتيجة: مكتمل." : "النتيجة: ناقص — عالج ما فوق قبل أن تعتمد على هذا النشر.");
  console.log(lines.join("\n"));
  if (!report.ok) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
