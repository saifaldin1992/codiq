/**
 * Regenerates CODIQ_LOGO_GUIDELINES.pdf from guidelines.src.html (ق-138).
 * Run from the repo root: `node docs/brand/render-guidelines.mjs`.
 * Uses the repo's own Playwright Chromium — no extra dependency.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = "file:///" + join(here, "guidelines.src.html").replaceAll("\\", "/");
const out = join(here, "CODIQ_LOGO_GUIDELINES.pdf");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(src, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.pdf({ path: out, format: "A4", printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
await browser.close();
console.log("PDF written:", out);
