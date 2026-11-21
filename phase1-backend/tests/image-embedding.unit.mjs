/**
 * Marketplace M12 — the visual fingerprint, on pictures drawn here.
 *
 * The same product photographed differently (smaller, re-compressed, cropped,
 * on another background, darker) must stay closer to the original than any
 * different product (another colour, a striped shirt, a ball). And the vector
 * has the shape pgvector expects: 256 finite numbers of unit length.
 */
import assert from "node:assert/strict";
import sharp from "sharp";

const { embedImage, vectorLiteral, IMAGE_EMBEDDING_DIMENSIONS } = await import(
  "../src/services/image-embedding.ts"
);
const svg = (body, bg = "#ffffff") =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="100%" height="100%" fill="${bg}"/>${body}</svg>`
  );
const dress = (colour) =>
  `<path d="M240 80 L360 80 L380 220 L470 720 L130 720 L220 220 Z" fill="${colour}"/>`;
const shirt = `<defs><pattern id="s" width="40" height="40" patternUnits="userSpaceOnUse"><rect width="20" height="40" fill="#1e3a8a"/><rect x="20" width="20" height="40" fill="#f5f5f5"/></pattern></defs><path d="M150 150 L250 100 L350 100 L450 150 L520 300 L440 330 L420 260 L420 720 L180 720 L180 260 L160 330 L80 300 Z" fill="url(#s)"/>`;
const ball = `<circle cx="300" cy="400" r="220" fill="#f97316"/><path d="M80 400 Q300 300 520 400" stroke="#111" stroke-width="10" fill="none"/>`;
const png = (buffer) => sharp(buffer).png().toBuffer();
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

const red = await png(svg(dress("#dc2626")));
const base = await embedImage(red);
assert.equal(base.length, IMAGE_EMBEDDING_DIMENSIONS);
assert.ok(base.every(Number.isFinite));
assert.ok(Math.abs(Math.hypot(...base) - 1) < 1e-9, "unit length");
assert.ok(
  Math.abs(dot(base, await embedImage(red)) - 1) < 1e-9,
  "the same bytes, the same numbers"
);

const same = {
  smallerAndCompressed: await sharp(red).resize(240).jpeg({ quality: 55 }).toBuffer(),
  cropped: await sharp(red)
    .extract({ left: 40, top: 30, width: 520, height: 720 })
    .jpeg()
    .toBuffer(),
  onGrey: await png(svg(dress("#dc2626"), "#d4d4d4")),
  darker: await sharp(red).modulate({ brightness: 0.8 }).jpeg().toBuffer(),
};
const other = {
  blueDress: await png(svg(dress("#2563eb"))),
  stripedShirt: await png(svg(shirt)),
  ball: await png(svg(ball)),
};
const scores = {};
for (const [name, buffer] of Object.entries({ ...same, ...other }))
  scores[name] = Number(dot(base, await embedImage(buffer)).toFixed(3));
const worstSame = Math.min(...Object.keys(same).map((name) => scores[name]));
const bestOther = Math.max(...Object.keys(other).map((name) => scores[name]));
console.error(JSON.stringify(scores));
assert.ok(
  worstSame > bestOther + 0.1,
  `every photo of the same dress (${worstSame}) beats every other product (${bestOther}) by a margin`
);
assert.ok(worstSame >= 0.8, `the same dress stays close (${worstSame})`);

await assert.rejects(
  embedImage(Buffer.from("<?php echo 1; ?>")),
  (error) => error.code === "IMAGE_UNREADABLE"
);
const literal = vectorLiteral(base);
assert.ok(literal.startsWith("[") && literal.endsWith("]"));
const parts = literal.slice(1, -1).split(",");
assert.equal(parts.length, 256);
assert.ok(
  parts.every((part) => /^-?\d\.\d{6}$/.test(part)),
  "numbers only, six decimals"
);
assert.throws(() => vectorLiteral([1, 2, 3]));
assert.throws(() => vectorLiteral(new Array(256).fill(Number.NaN)));

console.log(JSON.stringify({ suite: "image-embedding", ok: true, scores }, null, 2));
