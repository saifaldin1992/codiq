/**
 * ق-203 — ONE product card for the storefront: the home rails, the catalog
 * grid and the category page all draw this. Its shape is the reference shop's
 * (image · «جديد» badge · name · price · add-to-cart) in Codiq's own colours.
 */
import { Link } from "wouter";
import { PackageX, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StorefrontProduct, storefrontApi } from "@/lib/storefront-api";
import { priceLabel } from "@/lib/price-label";

/** «جديد» is an age, not a flag: a fortnight, and it clears itself. */
export const NEW_PRODUCT_DAYS = 14;
export function isNewProduct(
  product: Pick<StorefrontProduct, "createdAt">,
  now = Date.now()
): boolean {
  if (!product.createdAt) return false;
  const age = now - new Date(product.createdAt).valueOf();
  return age >= 0 && age < NEW_PRODUCT_DAYS * 24 * 60 * 60 * 1000;
}

export function ProductCard({
  slug,
  product,
  adding,
  onAdd,
}: {
  slug: string;
  product: StorefrontProduct;
  adding: boolean;
  onAdd: (productId: string) => void;
}) {
  const fresh = isNewProduct(product);
  return (
    <article
      data-testid="product-card"
      className="group flex h-full flex-col rounded-[22px] border border-[var(--storefront-border)] bg-[var(--storefront-surface)] p-3 shadow-[0_10px_28px_rgba(30,45,69,.05)] transition hover:shadow-[0_16px_36px_rgba(30,45,69,.09)]"
    >
      <Link href={`/store/${slug}/products/${product.id}`} className="block flex-1">
        <div className="relative aspect-square overflow-hidden rounded-[16px] bg-[var(--storefront-accent-soft)]">
          {product.image ? (
            <img
              loading="lazy"
              src={storefrontApi.imageUrl(slug, product.id, product.image.id)}
              alt={product.name}
              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="grid h-full place-items-center text-xs font-bold text-[var(--storefront-muted)]">
              لا توجد صورة
            </div>
          )}
          {fresh ? (
            <span
              data-testid="product-new-badge"
              className="absolute right-2 top-2 rounded-full bg-[var(--storefront-accent)] px-2.5 py-1 text-[11px] font-bold text-white shadow"
            >
              جديد
            </span>
          ) : null}
          {product.requiresPrescription ? (
            <span className="absolute left-2 top-2 rounded-full bg-violet-600/90 px-2.5 py-1 text-[11px] font-bold text-white">
              بوصفة طبية
            </span>
          ) : null}
          {!product.isAvailable ? (
            <span className="absolute inset-x-2 bottom-2 inline-flex items-center justify-center gap-1 rounded-full bg-[var(--codiq-accent-strong)] py-1 text-[11px] font-bold text-white">
              <PackageX className="h-3.5 w-3.5" />
              نفد المخزون
            </span>
          ) : null}
        </div>
        <h3 className="mt-3 line-clamp-2 min-h-[2.75rem] text-center text-sm font-bold leading-[1.4] text-[var(--storefront-text)]">
          {product.name}
        </h3>
        <p className="mt-1 text-center text-base font-black tabular-nums text-[var(--storefront-accent)]">
          {priceLabel(product)} <span className="text-xs font-bold">د.ع</span>
        </p>
      </Link>
      {product.hasOptions && product.isAvailable ? (
        <Link
          href={`/store/${slug}/products/${product.id}`}
          data-testid="product-card-choose"
          className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-xl bg-[var(--storefront-accent)] text-sm font-bold text-white hover:bg-[var(--storefront-accent-hover)]"
        >
          اختر الخيارات
        </Link>
      ) : (
        <Button
          type="button"
          disabled={adding || !product.isAvailable}
          onClick={() => onAdd(product.id)}
          className="mt-3 w-full rounded-xl bg-[var(--storefront-accent)] font-bold hover:bg-[var(--storefront-accent-hover)]"
        >
          <Plus className="ml-1.5 h-4 w-4" />
          {!product.isAvailable ? "نفد المخزون" : adding ? "جارٍ الإضافة…" : "أضف إلى السلة"}
        </Button>
      )}
    </article>
  );
}
