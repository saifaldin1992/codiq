/**
 * MD-4 «البائع الاجتماعي» — a ready-to-post product image, generated in the
 * merchant's own browser.
 *
 * WHY THE CLIENT. A server-side renderer would mean a second Arabic text stack
 * (fonts, shaping, RTL) that has to agree with the browser's, plus image
 * processing on request for something a merchant does a few times a day. The
 * browser already shapes Arabic correctly and already has the product image in
 * cache. Nothing here touches the server beyond fetching that image.
 *
 * WHAT IT PROMISES. Every figure on the card comes from the product as the API
 * returned it. A share image that says a price the storefront does not honour is
 * worse than no share image: the shopper arrives, sees a different number, and
 * the merchant looks dishonest for a rounding decision he never made.
 *
 * The image is drawn at 1080×1350 — the 4:5 that Instagram and WhatsApp status
 * both accept without recropping. A card cropped by the platform is a card with
 * its price cut off.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Download, LoaderCircle, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const WIDTH = 1080;
const HEIGHT = 1350;
const money = new Intl.NumberFormat("ar-IQ");
const FONT = '"Inter", "Rubik", "Noto Sans Arabic", system-ui, sans-serif';

/**
 * `imageUrl` is passed in rather than derived: the merchant dashboard and the
 * storefront serve the same photo from different paths, and a component that
 * guessed would work in one place and silently draw an empty box in the other.
 */
export interface ShareProduct { id: string; name: string; priceIqd: number; imageUrl?: string | null }

/**
 * Wraps RTL text by measuring words. `ctx.direction = "rtl"` shapes each line;
 * the breaking is ours because canvas has no line box.
 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = word; }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  // A name that does not fit says so with an ellipsis rather than being cut
  // mid-word, which reads as a broken card rather than a long name.
  if (lines.length === maxLines) {
    const consumed = lines.join(" ").split(/\s+/).length;
    if (consumed < words.length) lines[maxLines - 1] = `${lines[maxLines - 1]}…`;
  }
  return lines;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

export function ProductShareCard({ storeSlug, storeName, product, onClose }: { storeSlug: string; storeName?: string; product: ShareProduct; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  // The public link a shopper follows. This component is mounted in the merchant
  // DASHBOARD, so the origin is always the platform's — custom domains are not
  // routed by Host anywhere yet, and pretending otherwise here would put a link
  // on a post that resolves nowhere.
  const productUrl = `${window.location.origin}/store/${storeSlug}/products/${product.id}`;

  const draw = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) { setFailure("متصفحك لا يدعم توليد الصورة."); setBusy(false); return; }
    setBusy(true);
    try {
      // Without this the first render can measure and draw in a fallback face
      // and the card comes out in a font the merchant never chose.
      if (document.fonts?.ready) await document.fonts.ready;

      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      const background = ctx.createLinearGradient(0, 0, 0, HEIGHT);
      background.addColorStop(0, "#123A6B");
      background.addColorStop(1, "#1E6FDB");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      // ---- product image, cover-fitted into a rounded square
      const box = { x: 80, y: 96, size: WIDTH - 160 };
      ctx.save();
      roundedRect(ctx, box.x, box.y, box.size, box.size, 48);
      ctx.clip();
      ctx.fillStyle = "#0E2E56";
      ctx.fillRect(box.x, box.y, box.size, box.size);
      if (product.imageUrl) {
        // A missing photo must not lose the whole post, so EVERY way this can
        // fail is swallowed here rather than only a non-ok response: a rejected
        // fetch (offline, CORS on an image served from another origin) and a
        // createImageBitmap that throws on a corrupt file would otherwise escape
        // to the outer catch, and the merchant would get an error instead of a
        // card with a blank photo box.
        try {
          const response = await fetch(product.imageUrl, { credentials: "same-origin" });
          if (response.ok) {
            const bitmap = await createImageBitmap(await response.blob());
            const scale = Math.max(box.size / bitmap.width, box.size / bitmap.height);
            const width = bitmap.width * scale;
            const height = bitmap.height * scale;
            ctx.drawImage(bitmap, box.x + (box.size - width) / 2, box.y + (box.size - height) / 2, width, height);
            bitmap.close();
          }
        } catch {
          // Deliberately silent: the card is the deliverable, the photo is not.
        }
      }
      ctx.restore();

      // ---- name and price
      ctx.direction = "rtl";
      ctx.textAlign = "right";
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 62px ${FONT}`;
      const right = WIDTH - 80;
      let cursor = box.y + box.size + 108;
      for (const line of wrap(ctx, product.name, WIDTH - 160, 2)) {
        ctx.fillText(line, right, cursor);
        cursor += 76;
      }

      ctx.font = `900 84px ${FONT}`;
      ctx.fillText(`${money.format(product.priceIqd)} د.ع`, right, cursor + 26);

      // ---- store name and the link a shopper types
      ctx.font = `600 34px ${FONT}`;
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.fillText(storeName ?? storeSlug, right, HEIGHT - 118);
      ctx.direction = "ltr";
      ctx.textAlign = "left";
      ctx.font = `500 30px ${FONT}`;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(productUrl.replace(/^https?:\/\//, ""), 80, HEIGHT - 118);

      const generated = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      setBlob(generated);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "تعذر توليد الصورة.");
    } finally {
      setBusy(false);
    }
  }, [product.id, product.imageUrl, product.name, product.priceIqd, storeSlug, storeName, productUrl]);

  useEffect(() => { void draw(); }, [draw]);

  const fileName = `codiq-${product.id}.png`;
  function download() {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function share() {
    if (!blob) return;
    const file = new File([blob], fileName, { type: "image/png" });
    // `canShare` is checked with the actual file: a browser may have `share`
    // and still refuse files, and calling it then throws in the user's face.
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], text: `${product.name} — ${money.format(product.priceIqd)} د.ع`, url: productUrl }); return; }
      catch { /* the merchant dismissed the sheet; that is not an error */ return; }
    }
    download();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[#0B1A2F]/50 p-4">
      <div className="w-full max-w-sm space-y-3 rounded-3xl bg-[var(--codiq-surface)] p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-[var(--codiq-accent-strong)]">صورة جاهزة للنشر</p>
          <Button size="sm" variant="ghost" onClick={onClose} className="rounded-xl text-[var(--codiq-text-secondary)]">إغلاق</Button>
        </div>
        <div className="relative overflow-hidden rounded-2xl bg-[#0E2E56]">
          <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} className="block h-auto w-full" role="img" aria-label={`صورة مشاركة لمنتج ${product.name}`} />
          {busy ? <div className="absolute inset-0 grid place-items-center bg-white/70"><LoaderCircle className="h-6 w-6 animate-spin text-[var(--codiq-accent)]" /></div> : null}
        </div>
        {failure ? <p className="flex items-center gap-2 rounded-xl bg-[var(--codiq-danger-soft)] px-3 py-2 text-[13px] font-semibold text-[var(--codiq-danger)]"><CircleAlert className="h-4 w-4" /> {failure}</p> : null}
        <p className="text-[11px] leading-5 text-[var(--codiq-text-muted)]">السعر والاسم مأخوذان من المنتج كما هو الآن. إن غيّرتهما، أعد توليد الصورة.</p>
        <div className="flex gap-2">
          <Button type="button" disabled={!blob} onClick={() => void share()} className="flex-1 rounded-xl bg-[var(--codiq-accent)] hover:bg-[var(--codiq-accent-hover)]"><Share2 className="ml-1 h-4 w-4" /> مشاركة</Button>
          <Button type="button" variant="outline" disabled={!blob} onClick={download} className="rounded-xl"><Download className="ml-1 h-4 w-4" /> تنزيل</Button>
        </div>
      </div>
    </div>
  );
}
