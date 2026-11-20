/**
 * ق-241 — the platform was sending Arabic uncompressed, and Arabic is the
 * whole payload.
 *
 * Every byte CODIQ sends is Arabic UTF-8: two bytes per letter on the wire, and
 * text that compresses better than Latin does. Railway bills egress at $0.05/GB
 * and the cost model put egress at roughly nine tenths of the monthly bill — so
 * this is the largest single cost lever in the platform. The shopper on an Iraqi
 * mobile network is the other half of the reason, and the more important one.
 *
 * FOUR THINGS ARE ASSERTED, and each of them is a way this can be got wrong:
 *
 *   1. an Arabic JSON body above the floor comes back ENCODED, and decodes
 *      BYTE-FOR-BYTE to what the handler wrote — a compressor that corrupts the
 *      tail of a UTF-8 sequence would still look fine in a size assertion
 *   2. `Vary: Accept-Encoding` is present, or a shared cache serves a gzipped
 *      body to a client that never asked for one
 *   3. a client that asks for nothing still gets a correct, plain answer
 *   4. an already-compressed payload (a webp product image) is NOT recompressed
 *
 * The measured ratio is printed rather than asserted against a fixed number:
 * the number is evidence for a human, and pinning it would make this guard fail
 * on a zlib upgrade for no reason anyone cares about.
 */
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { promisify } from "node:util";
import express from "express";
import compression from "compression";

const gunzip = promisify(zlib.gunzip);
const brotliDecompress = promisify(zlib.brotliDecompress);
const summary = {};

// A body shaped like the real thing: an order list, in Arabic, with the
// repetition every JSON list has (the same keys on every row).
const order = (index) => ({
  id: `ord_${String(index).padStart(6, "0")}`,
  customerName: "محمد عبد الرحمن الجبوري",
  governorate: "بغداد",
  address: "الكرادة داخل، محلة ٩٠٩، زقاق ١٢، دار ٤٧",
  phone: `0770${String(1000000 + index).slice(0, 7)}`,
  status: "قيد التجهيز",
  paymentMethod: "الدفع عند الاستلام",
  items: [
    { name: "عطر شرقي فاخر ١٠٠ مل", quantity: 1, price: 45000 },
    { name: "كريم مرطّب للبشرة الجافة", quantity: 2, price: 12500 },
  ],
  note: "يُفضّل الاتصال قبل التوصيل بساعة",
});
const payload = { items: Array.from({ length: 25 }, (_, i) => order(i)), nextCursor: null };
const plainJson = JSON.stringify(payload);

// A minimal valid webp, standing in for a product image: already compressed,
// and the one content type that must come back untouched.
const webp = Buffer.concat([
  Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "),
  Buffer.alloc(2048, 0x7f),
]);
webp.writeUInt32LE(webp.length - 8, 4);

const app = express();
app.use(compression());
app.get("/orders", (_request, response) => response.type("application/json").send(plainJson));
app.get("/tiny", (_request, response) => response.type("application/json").send(JSON.stringify({ ok: true })));
app.get("/image", (_request, response) => response.type("image/webp").send(webp));

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.on("exit", () => { try { server.close(); } catch { /* already closed */ } });

/** Raw, so the client never decodes for us and hides what actually came over the wire. */
function get(path, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const headers = acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding };
    const request = http.request(`${base}${path}`, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end();
  });
}

// ============================================================
// 1. Arabic JSON is encoded, and decodes back byte-for-byte.
// ============================================================
const plain = await get("/orders", "identity");
assert.equal(plain.headers["content-encoding"], undefined, "a client asking for identity gets none");
assert.equal(plain.body.toString("utf8"), plainJson, "…and the plain answer is the handler's own bytes");

const gzipped = await get("/orders", "gzip");
assert.equal(gzipped.headers["content-encoding"], "gzip", "ق-241: an Arabic JSON list above the floor MUST come back compressed");
const fromGzip = await gunzip(gzipped.body);
assert.equal(fromGzip.toString("utf8"), plainJson, "…and gunzip must return the handler's bytes exactly — a truncated UTF-8 tail would pass a size check and break a shopper's screen");

const brotli = await get("/orders", "br");
assert.equal(brotli.headers["content-encoding"], "br", "brotli is preferred when the client offers it");
assert.equal((await brotliDecompress(brotli.body)).toString("utf8"), plainJson, "…and it too round-trips exactly");

const rawBytes = Buffer.byteLength(plainJson);
const ratio = (encoded) => `${(100 - (encoded / rawBytes) * 100).toFixed(1)}%`;
summary.arabicJson = {
  raw: rawBytes,
  gzip: gzipped.body.length,
  brotli: brotli.body.length,
  saved: { gzip: ratio(gzipped.body.length), brotli: ratio(brotli.body.length) },
};

// ============================================================
// 2. Vary — or a shared cache poisons a client that cannot decode.
// ============================================================
for (const [label, response] of [["gzip", gzipped], ["br", brotli], ["identity", plain]]) {
  assert.match(String(response.headers.vary ?? ""), /accept-encoding/i, `«${label}»: Vary must name Accept-Encoding — without it a shared cache can hand a gzipped body to a client that never asked`);
}
summary.vary = "every answer carries Vary: Accept-Encoding, compressed or not";

// ============================================================
// 3. A client that says nothing at all still gets a correct answer.
// ============================================================
const silent = await get("/orders", undefined);
const silentBody = silent.headers["content-encoding"] === "gzip" ? await gunzip(silent.body) : silent.body;
assert.equal(silentBody.toString("utf8"), plainJson, "a request with no Accept-Encoding still gets the right bytes");
summary.noHeader = `a client that sends no Accept-Encoding gets «${silent.headers["content-encoding"] ?? "identity"}» and the correct body`;

// ============================================================
// 4. What must NOT be compressed.
// ============================================================
const image = await get("/image", "gzip, br");
assert.equal(image.headers["content-encoding"], undefined, "ق-238's webp variants are already compressed — recompressing costs CPU and usually ADDS bytes");
assert.equal(image.body.length, webp.length, "…and the image arrives untouched");

const tiny = await get("/tiny", "gzip, br");
assert.equal(tiny.headers["content-encoding"], undefined, "below the 1 KB floor the encoding header is most of the saving");
summary.skips = "image/webp and anything under 1 KB are sent as-is";

server.close();
console.log(JSON.stringify({ suite: "compression", status: "passed", summary }, null, 2));
