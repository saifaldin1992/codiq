// The express Express type is imported under an alias here: this module's image
// upload handler references the global Express.Multer.File namespace type, which
// a named `Express` import would shadow.
import type { Express as ExpressApp } from "express";
import { assertCapabilityAvailable } from "../../services/availability.service.js";
import multer from "multer";
import { HttpError } from "../../auth/auth.errors.js";
import { requireStoreActor } from "../../auth/staff-permissions.js";
import { prisma } from "../../db/prisma.js";
import {
  commitProductsImport,
  exportProductsCsv,
  validateProductsCsv,
} from "../../services/csv-transfer.service.js";
import {
  addProductImages,
  adjustInventory,
  adjustVariantInventory,
  createCategory,
  createProduct,
  createVariant,
  deleteCategory,
  deleteProduct,
  deleteVariant,
  duplicateProduct,
  listCategories,
  listProducts,
  listVariants,
  productImageForStore,
  productPayload,
  updateCategory,
  updateProduct,
  updateVariant,
} from "../../services/product-catalog.service.js";
import {
  getProductImageBytes,
  productImageConstraints,
} from "../../services/product-image-storage.service.js";
import {
  DEFAULT_SERVED_VARIANT,
  isVariantName,
  variantObjectKey,
} from "../../services/image-variants.service.js";
import { listInventoryMovements } from "../../services/inventory-movements.service.js";
import { LIVE } from "../../services/soft-delete/constants.js";
import { catalogProductSearchQuerySchema } from "../schemas/search.schema.js";
import {
  createCategorySchema,
  createProductSchema,
  createVariantSchema,
  inventoryAdjustmentSchema,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
} from "../schemas/catalog.schema.js";
import { parseOrThrow } from "../validate.js";
import {
  asyncRoute,
  authenticatedUpload,
  limitUpload,
  uploadLimits,
  requireTrustedWriteOrigin,
} from "../shared.js";

const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: uploadLimits({ fileSize: productImageConstraints.maxBytes, files: 8 }),
  fileFilter: (_request, file, callback) =>
    callback(null, productImageConstraints.allowedContentTypes.has(file.mimetype)),
});

// Phase 20B-3 (D-25): CSV import rides multer memory storage with a 2 MB cap —
// far above the 2000-row limit the service enforces on the parsed rows.
const csvImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: uploadLimits({ fileSize: 2 * 1024 * 1024, files: 1 }),
});

/**
 * 19-د (ATTACK-SURFACE): the authorization that runs BEFORE multer buffers a
 * byte. See `authenticatedUpload` in http/shared.ts for why the order is the
 * whole point. The rate-limit key is the ACTOR, not the address — the ceiling
 * has to survive an attacker who changes IP, and it must not let one busy shop
 * on a shared connection lock out its neighbour.
 */
async function guardCatalogUpload(
  request: import("express").Request,
  permission: Parameters<typeof requireStoreActor>[1],
  scope: string
) {
  requireTrustedWriteOrigin(request);
  const { store, actor } = await requireStoreActor(request, permission);
  await limitUpload(scope, `${store.id}:${actor.kind}:${actor.id}`);
}

export function registerCatalogRoutes(app: ExpressApp) {
  app.get(
    "/merchant/stores/:storeSlug/catalog/categories",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.products.view");
      response
        .status(200)
        .json({ storeSlug: store.slug, categories: await listCategories(store.id) });
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/catalog/categories",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.categories.manage");
      response
        .status(201)
        .json({
          category: await createCategory(
            store.id,
            parseOrThrow(createCategorySchema, request.body ?? {})
          ),
        });
    })
  );
  app.patch(
    "/merchant/stores/:storeSlug/catalog/categories/:categoryId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.categories.manage");
      response
        .status(200)
        .json({
          category: await updateCategory(
            store.id,
            request.params.categoryId,
            parseOrThrow(updateCategorySchema, request.body ?? {})
          ),
        });
    })
  );
  // PG-2: the two deletes below answer 200 with { id, deletedAt, purgeAt } instead
  // of a bare 204. The client needs `purgeAt` for «يُحذف نهائياً بعد ١٢ يوماً» and
  // the id for the «تراجع» button that calls restore straight back.
  app.delete(
    "/merchant/stores/:storeSlug/catalog/categories/:categoryId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "catalog.categories.manage");
      response.status(200).json(await deleteCategory(store.id, request.params.categoryId, actor));
    })
  );
  app.get(
    "/merchant/stores/:storeSlug/catalog/products",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.products.view");
      // PG-6 (ق-74): `q` is NEW here, so it lands with a schema from the start.
      // Only `q` is parsed: `limit`, `cursor` and `lowStock` are pre-existing
      // inputs with pre-existing clamping, and 20-2 unifies those everywhere at
      // once rather than one route at a time.
      const { q } = parseOrThrow(catalogProductSearchQuerySchema, { q: request.query.q });
      const page = await listProducts(
        store.id,
        request.query.limit,
        request.query.cursor,
        request.query.lowStock === "true",
        q
      );
      response.status(200).json({ storeSlug: store.slug, ...page });
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/catalog/products",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.create");
      response
        .status(201)
        .json({
          product: await createProduct(
            store.id,
            parseOrThrow(createProductSchema, request.body ?? {})
          ),
        });
    })
  );
  app.get(
    "/merchant/stores/:storeSlug/catalog/products/:productId",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.products.view");
      const product = await prisma.product.findFirst({
        where: { id: request.params.productId, storeId: store.id, ...LIVE },
        include: {
          category: { select: { id: true, name: true } },
          images: {
            select: { id: true, contentType: true, byteSize: true, sortOrder: true },
            orderBy: { sortOrder: "asc" },
          },
          variants: {
            where: { deletedAt: null },
            orderBy: [{ isDefault: "desc" }, { position: "asc" }, { createdAt: "asc" }],
          },
        },
      });
      if (!product)
        throw new HttpError(
          404,
          "RESOURCE_NOT_FOUND",
          "The requested product was not found in this store."
        );
      response.status(200).json({ product: productPayload(product) });
    })
  );
  app.patch(
    "/merchant/stores/:storeSlug/catalog/products/:productId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.update");
      response
        .status(200)
        .json({
          product: await updateProduct(
            store.id,
            request.params.productId,
            parseOrThrow(updateProductSchema, request.body ?? {})
          ),
        });
    })
  );
  app.delete(
    "/merchant/stores/:storeSlug/catalog/products/:productId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store, actor } = await requireStoreActor(request, "catalog.products.delete");
      response.status(200).json(await deleteProduct(store.id, request.params.productId, actor));
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/catalog/products/:productId/inventory",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "inventory.update");
      response
        .status(200)
        .json({
          product: await adjustInventory(
            store.id,
            request.params.productId,
            parseOrThrow(inventoryAdjustmentSchema, request.body ?? {})
          ),
        });
    })
  );
  // ق-176: the movement log, READ. Written in thirteen places since phase 7 and
  // read in none — the delete sheet promised it was kept forever, and it was,
  // behind no door. `inventory.update` because the reader is whoever adjusts
  // stock and needs to see why it moved; store staff hold it too.
  app.get(
    "/merchant/stores/:storeSlug/inventory/movements",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "inventory.update");
      response
        .status(200)
        .json({
          storeSlug: store.slug,
          ...(await listInventoryMovements(
            store.id,
            request.query.limit,
            request.query.cursor,
            request.query.productId
          )),
        });
    })
  );
  // Phase 20A: variant management. Variants are part of the product offering, so
  // create/update ride catalog.products.update, deletion rides catalog.products.delete,
  // and stock adjustments ride inventory.update — the same codes the matrix already enforces.
  app.get(
    "/merchant/stores/:storeSlug/catalog/products/:productId/variants",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.products.view");
      response
        .status(200)
        .json({ variants: await listVariants(store.id, request.params.productId) });
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/catalog/products/:productId/variants",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.update");
      response
        .status(201)
        .json({
          variant: await createVariant(
            store.id,
            request.params.productId,
            parseOrThrow(createVariantSchema, request.body ?? {})
          ),
        });
    })
  );
  app.patch(
    "/merchant/stores/:storeSlug/catalog/products/:productId/variants/:variantId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.update");
      response
        .status(200)
        .json({
          variant: await updateVariant(
            store.id,
            request.params.productId,
            request.params.variantId,
            parseOrThrow(updateVariantSchema, request.body ?? {})
          ),
        });
    })
  );
  app.delete(
    "/merchant/stores/:storeSlug/catalog/products/:productId/variants/:variantId",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.delete");
      await deleteVariant(store.id, request.params.productId, request.params.variantId);
      response.status(204).end();
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/catalog/products/:productId/variants/:variantId/inventory",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "inventory.update");
      response
        .status(200)
        .json({
          variant: await adjustVariantInventory(
            store.id,
            request.params.productId,
            request.params.variantId,
            parseOrThrow(inventoryAdjustmentSchema, request.body ?? {})
          ),
        });
    })
  );
  app.post(
    "/merchant/stores/:storeSlug/catalog/products/:productId/images",
    authenticatedUpload(
      (request) => guardCatalogUpload(request, "catalog.products.update", "product_image_upload"),
      productImageUpload.array("images", 8)
    ),
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.update");
      const files = (request.files ?? []) as Express.Multer.File[];
      if (!files.length)
        throw new HttpError(
          422,
          "INVALID_PRODUCT_IMAGE",
          "At least one product image is required."
        );
      response
        .status(201)
        .json({ images: await addProductImages(store.id, request.params.productId, files) });
    })
  );
  // ق-238: the merchant's own catalog grid is a grid of cards too — it was
  // pulling full-size originals to draw thumbnails. Same `?v=` contract as the
  // storefront, same default. No cache header here on purpose: this answer is
  // behind a session, and ق-230 stamps `no-store` on anything that carries one.
  app.get(
    "/merchant/stores/:storeSlug/catalog/products/:productId/images/:imageId",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.products.view");
      const image = await productImageForStore(
        store.id,
        request.params.productId,
        request.params.imageId
      );
      const variant = isVariantName(request.query.v) ? request.query.v : DEFAULT_SERVED_VARIANT;
      const objectKey = image.variantSet
        ? variantObjectKey(image.objectKey, variant)
        : image.objectKey;
      response.type(image.contentType).send(await getProductImageBytes(objectKey));
    })
  );
  // ---------- Phase 20B-3 (D-25): CSV import/export — appended after every
  // pre-existing route; the paths (`catalog/import/…`, `catalog/export/…`) share
  // no pattern with the routes above, so the legacy matching order is intact.
  app.post(
    "/merchant/stores/:storeSlug/catalog/import/products",
    authenticatedUpload(
      (request) => guardCatalogUpload(request, "catalog.products.create", "csv_import_upload"),
      csvImportUpload.single("file")
    ),
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.create");
      await assertCapabilityAvailable("data.csv", store);
      if (!request.file?.buffer?.length)
        throw new HttpError(422, "CSV_FILE_REQUIRED", "أرفق ملف CSV في الحقل «file».");
      const validation = await validateProductsCsv(store.id, request.file.buffer);
      const preview = {
        totalRows: validation.totalRows,
        newProducts: validation.newProducts,
        newVariants: validation.newVariants,
        errors: validation.errors,
      };
      if (request.query.dryRun === "true") {
        response.status(200).json({ dryRun: true, ...preview });
        return;
      }
      if (validation.errors.length) {
        // All-or-nothing (decision §8.8): a single bad row rejects the whole file
        // with the same row-error shape the mandatory preview shows — zero writes.
        response
          .status(422)
          .json({
            error: {
              code: "CSV_VALIDATION_FAILED",
              message:
                "الملف مرفوض بالكامل — أصلِح الصفوف المعلّمة ثم أعِد المحاولة (لا استيراد جزئياً).",
            },
            validation: preview,
          });
        return;
      }
      const result = await commitProductsImport(store.id, validation);
      response.status(201).json({ dryRun: false, totalRows: validation.totalRows, ...result });
    })
  );
  // ---------- MD-1: «نسخ منتج بنقرة». Appended after every pre-existing route;
  // the `…/products/:productId/duplicate` path shares no pattern with the routes
  // above, so the legacy matching order is intact. Creating a product is the
  // effect, so the guard is catalog.products.create.
  app.post(
    "/merchant/stores/:storeSlug/catalog/products/:productId/duplicate",
    asyncRoute(async (request, response) => {
      requireTrustedWriteOrigin(request);
      const { store } = await requireStoreActor(request, "catalog.products.create");
      response
        .status(201)
        .json({ product: await duplicateProduct(store.id, request.params.productId) });
    })
  );
  app.get(
    "/merchant/stores/:storeSlug/catalog/export/products.csv",
    asyncRoute(async (request, response) => {
      const { store } = await requireStoreActor(request, "catalog.products.view");
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      await assertCapabilityAvailable("data.csv", store);
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="products-${store.slug}.csv"`
      );
      await exportProductsCsv(store.id, (chunk) => response.write(chunk));
      response.end();
    })
  );
}
