/**
 * Marketplace M12 — fingerprint market products for «البحث بالصورة» from the
 * command line or a scheduler: `pnpm market:image-index [batches]`. Each batch
 * is up to 200 products; it stops early when nothing is left.
 */
import { prisma } from "../src/db/prisma.js";
import { indexProductImages } from "../src/modules/market-visual/visual.service.js";

const batches = Math.max(1, Math.min(Number.parseInt(process.argv[2] ?? "10", 10) || 10, 1000));
try {
  let total = 0,
    failed = 0,
    pending = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const run = await indexProductImages(200);
    total += run.indexedNow;
    failed += run.failed;
    pending = run.pending;
    if (run.indexedNow === 0 || run.pending === 0) break;
  }
  console.log(JSON.stringify({ indexed: total, failed, pending }));
} finally {
  await prisma.$disconnect();
}
