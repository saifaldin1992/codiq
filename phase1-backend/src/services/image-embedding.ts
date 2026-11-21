/**
 * Marketplace M12 — a picture's visual fingerprint: 256 numbers.
 *
 * WHAT IT IS. Not a neural network: four classic descriptors, each of which
 * survives the things that differ between a merchant's product photo and a
 * shopper's photo of the same thing (size, compression, a little crop or
 * light), computed here with sharp — no model to download, no service to call,
 * no shopper photo leaving the server.
 *
 *   96  colour — hue × saturation × brightness histogram (16 × 3 × 2), with the
 *       photo's BACKGROUND (the colour of its border) counted at a sixth, so a
 *       red bag on white and a red bag on grey look alike.
 *   48  layout — the mean colour of each cell of a 4 × 4 grid, relative to the
 *       picture's own mean, so a darker photo of the same thing keeps its layout.
 *   48  edges  — gradient orientation histograms (12 directions) per quarter:
 *       stripes, round shapes and straight edges.
 *   64  shape  — a difference hash of the brightness.
 *
 * Each block is normalised, weighted, and the whole vector normalised to unit
 * length, so cosine similarity is a plain dot product in [-1, 1]. What it finds
 * is «looks like» (colour, pattern, silhouette) — a black dress finds black
 * dresses — not «is the same kind of thing» in the way a trained model would.
 * `IMAGE_EMBEDDING_MODEL` names this version so a better one can replace it
 * product by product.
 */
import sharp from "sharp";
import { HttpError } from "../auth/auth.errors.js";

export const IMAGE_EMBEDDING_MODEL = "codiq-visual-v1";
export const IMAGE_EMBEDDING_DIMENSIONS = 256;
const SIDE = 64;
const WEIGHTS = { colour: 1.3, layout: 0.7, edges: 0.9, shape: 0.6 };

function normalise(values: number[], weight: number) {
  const length = Math.hypot(...values);
  return length > 0 ? values.map((value) => (value / length) * weight) : values.map(() => 0);
}

function hsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

/** The 256 numbers for one picture. Refuses what sharp cannot decode (422). */
export async function embedImage(input: Buffer): Promise<number[]> {
  let raw: Buffer;
  let hashPixels: Buffer;
  try {
    const base = sharp(input, { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .flatten({ background: "#ffffff" });
    raw = await base.clone().resize(SIDE, SIDE, { fit: "fill" }).removeAlpha().raw().toBuffer();
    hashPixels = await base.clone().resize(9, 8, { fit: "fill" }).greyscale().raw().toBuffer();
  } catch {
    throw new HttpError(
      422,
      "IMAGE_UNREADABLE",
      "تعذّرت قراءة الصورة. جرّب صورة JPG أو PNG أو WebP."
    );
  }
  const pixel = (x: number, y: number) => {
    const i = (y * SIDE + x) * 3;
    return [raw[i] / 255, raw[i + 1] / 255, raw[i + 2] / 255] as const;
  };

  // The background: the mean colour of the outermost ring of pixels.
  let br = 0,
    bg = 0,
    bb = 0,
    ring = 0;
  for (let i = 0; i < SIDE; i += 1)
    for (const [x, y] of [
      [i, 0],
      [i, SIDE - 1],
      [0, i],
      [SIDE - 1, i],
    ]) {
      const [r, g, b] = pixel(x, y);
      br += r;
      bg += g;
      bb += b;
      ring += 1;
    }
  br /= ring;
  bg /= ring;
  bb /= ring;

  const colour = new Array(96).fill(0);
  const layout = new Array(48).fill(0);
  const grey = new Float64Array(SIDE * SIDE);
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const [r, g, b] = pixel(x, y);
      grey[y * SIDE + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      const background = Math.hypot(r - br, g - bg, b - bb) < 0.12;
      const weight = background ? 1 / 6 : 1;
      const { h, s, v } = hsv(r, g, b);
      // Soft bins: a pixel near a boundary is shared between the two bins beside
      // it, so a slightly darker or paler photo moves weight gradually instead of
      // jumping to another bin (hue wraps round; grey has no hue and goes to 0).
      const huePos = s < 0.12 ? 0 : h / 22.5 - 0.5;
      const satPos = Math.min(Math.max(s * 3 - 0.5, 0), 2);
      const valPos = Math.min(Math.max(v * 2 - 0.5, 0), 1);
      const h0 = Math.floor(huePos),
        s0 = Math.floor(satPos),
        v0 = Math.floor(valPos);
      const hf = huePos - h0,
        sf = satPos - s0,
        vf = valPos - v0;
      for (const [dh, wh] of [
        [0, 1 - hf],
        [1, hf],
      ] as const) {
        for (const [ds, ws] of [
          [0, 1 - sf],
          [1, sf],
        ] as const) {
          for (const [dv, wv] of [
            [0, 1 - vf],
            [1, vf],
          ] as const) {
            const share = weight * wh * ws * wv;
            if (share <= 0) continue;
            const hueBin = (((h0 + dh) % 16) + 16) % 16;
            colour[(hueBin * 3 + Math.min(s0 + ds, 2)) * 2 + Math.min(v0 + dv, 1)] += share;
          }
        }
      }
      const cell = Math.floor(y / 16) * 4 + Math.floor(x / 16);
      layout[cell * 3] += r / 256;
      layout[cell * 3 + 1] += g / 256;
      layout[cell * 3 + 2] += b / 256;
    }
  }

  // Relative to the picture's own mean colour, then scaled by its spread: light and contrast drop out.
  for (let channel = 0; channel < 3; channel += 1) {
    const cells = Array.from({ length: 16 }, (_, cell) => layout[cell * 3 + channel]);
    const mean = cells.reduce((sum, value) => sum + value, 0) / 16;
    const spread = Math.sqrt(cells.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 16) || 1;
    cells.forEach((value, cell) => {
      layout[cell * 3 + channel] = (value - mean) / spread;
    });
  }

  const edges = new Array(48).fill(0);
  for (let y = 1; y < SIDE - 1; y += 1) {
    for (let x = 1; x < SIDE - 1; x += 1) {
      const at = (dx: number, dy: number) => grey[(y + dy) * SIDE + x + dx];
      const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
      const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < 0.05) continue;
      const angle = (Math.atan2(gy, gx) + Math.PI) % Math.PI;
      const bin = Math.min(11, Math.floor((angle / Math.PI) * 12));
      const quarter = (y < SIDE / 2 ? 0 : 2) + (x < SIDE / 2 ? 0 : 1);
      edges[quarter * 12 + bin] += magnitude;
    }
  }

  const shape: number[] = [];
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 8; x += 1)
      shape.push(hashPixels[y * 9 + x] < hashPixels[y * 9 + x + 1] ? 1 : -1);

  // Square roots of the histograms (Hellinger): one dominant colour no longer drowns the rest.
  const vector = [
    ...normalise(colour.map(Math.sqrt), WEIGHTS.colour),
    ...normalise(layout, WEIGHTS.layout),
    ...normalise(edges.map(Math.sqrt), WEIGHTS.edges),
    ...normalise(shape, WEIGHTS.shape),
  ];
  return normalise(vector, 1);
}

/** pgvector's text form, built from numbers only. */
export function vectorLiteral(values: number[]): string {
  if (values.length !== IMAGE_EMBEDDING_DIMENSIONS || !values.every(Number.isFinite))
    throw new Error("embedding has the wrong shape");
  return `[${values.map((value) => value.toFixed(6)).join(",")}]`;
}
