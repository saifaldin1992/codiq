/**
 * codiq approved addition (2026-08-26) — nested category tree integration proof.
 * Follows the phase9a harness (real HTTP app + raw pg client) and proves,
 * against a real PostgreSQL:
 *  1. nested creation up to 3 levels, parentCategoryId returned everywhere;
 *  2. cycles rejected twice: service 422 INVALID_CATEGORY_PARENT and the DB
 *     trigger (raw SQL) for direct writes;
 *  3. depth 4 rejected on create AND on re-parenting a subtree (422
 *     CATEGORY_DEPTH_EXCEEDED);
 *  4. cross-store parent rejected at the API (404) and by the composite
 *     same-store FK for raw SQL (23503);
 *  5. delete guards: children first (409 CATEGORY_HAS_CHILDREN + FK RESTRICT
 *     at the schema level), assigned products second (409 CATEGORY_IN_USE);
 *  6. storefront rollup: a parent filter returns descendants' products, the
 *     public category list carries parentCategoryId and shows parents whose
 *     products live only in children — without leaking another store's tree;
 *  7. legacy flat categories behave exactly as before.
 */
import assert from "node:assert/strict";
import { registerMerchantDirect } from "./helpers/register-merchant.js";
import { Client } from "pg";

const testId = `cathier-${Date.now()}`;
process.env.SESSION_JWT_SECRET = "category-hierarchy-test-secret-only";
const { assertSafeTestDatabaseUrl } = await import("./helpers/test-database-guard.ts");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.CODIQ_TEST_DATABASE_URL);
process.env.DATABASE_URL = testDatabaseUrl;
process.env.CODIQ_POSTGRES_URL = testDatabaseUrl;

const { createApp } = await import("../src/http/app.ts");
const { prisma } = await import("../src/db/prisma.ts");

const sql = new Client({ connectionString: process.env.DATABASE_URL });
await sql.connect();
const app = createApp();
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    payload: response.status === 204 ? null : await response.json().catch(() => null),
  };
}

try {
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE storefront_rate_limits, notification_outbox, inventory_reservations, checkout_requests, cart_items, shopping_carts, customer_addresses, order_status_events, order_items, store_orders, inventory_movements, product_images, product_variants, products, product_categories, customer_sessions, customers, merchant_sessions, stores, merchants, platform_owner_sessions, platform_owners CASCADE"
  );

  const merchantA = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100363801",
    email: `${testId}.merchant-a@codiq.test`,
    password: "CatHierMerchantPass123!",
    businessName: "متجر التصنيفات ألف",
  });
  const merchantB = await registerMerchantDirect({
    ownerName: "صاحب المتجر",
    phone: "+9647100363802",
    email: `${testId}.merchant-b@codiq.test`,
    password: "CatHierMerchantPass123!",
    businessName: "متجر التصنيفات باء",
  });
  assert.equal(merchantA.status, 201);
  assert.equal(merchantB.status, 201);
  const storeA = await prisma.store.create({
    data: {
      merchantId: merchantA.payload.account.id,
      name: "متجر التصنيفات ألف",
      slug: `${testId}-a`,
      defaultSubdomain: `${testId}-a`,
    },
  });
  const storeB = await prisma.store.create({
    data: {
      merchantId: merchantB.payload.account.id,
      name: "متجر التصنيفات باء",
      slug: `${testId}-b`,
      defaultSubdomain: `${testId}-b`,
    },
  });
  const loginA = await request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: `${testId}.merchant-a@codiq.test`, password: "CatHierMerchantPass123!" },
  });
  const loginB = await request("/auth/merchant/login", {
    method: "POST",
    body: { identifier: `${testId}.merchant-b@codiq.test`, password: "CatHierMerchantPass123!" },
  });
  assert.equal(loginA.status, 200);
  assert.equal(loginB.status, 200);
  const tokenA = loginA.payload.accessToken;
  const tokenB = loginB.payload.accessToken;
  const categoriesA = `/merchant/stores/${storeA.slug}/catalog/categories`;

  // ---------- 1. nested creation: 3 levels, parentCategoryId everywhere ----------
  const root = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "عطور" },
  });
  assert.equal(root.status, 201);
  assert.equal(root.payload.category.parentCategoryId, null, "flat create keeps a null parent");
  const child = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "عطور رجالية", parentCategoryId: root.payload.category.id },
  });
  assert.equal(child.status, 201, JSON.stringify(child.payload));
  assert.equal(child.payload.category.parentCategoryId, root.payload.category.id);
  const grandchild = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "عطور نيش رجالية", parentCategoryId: child.payload.category.id },
  });
  assert.equal(grandchild.status, 201);
  assert.equal(grandchild.payload.category.parentCategoryId, child.payload.category.id);
  const merchantList = await request(categoriesA, { token: tokenA });
  assert.equal(merchantList.status, 200);
  const listedChild = merchantList.payload.categories.find(
    (category) => category.id === child.payload.category.id
  );
  assert.equal(
    listedChild.parentCategoryId,
    root.payload.category.id,
    "listCategories must return parentCategoryId for tree building"
  );
  assert.equal(typeof listedChild._count.products, "number", "legacy list fields preserved");

  // ---------- 3. depth 4 rejected on create ----------
  const depth4 = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "مستوى رابع", parentCategoryId: grandchild.payload.category.id },
  });
  assert.equal(depth4.status, 422);
  assert.equal(depth4.payload.error.code, "CATEGORY_DEPTH_EXCEEDED");

  // ---------- 2. cycles: service-level 422 ----------
  const selfParent = await request(`${categoriesA}/${root.payload.category.id}`, {
    method: "PATCH",
    token: tokenA,
    body: { name: "عطور", parentCategoryId: root.payload.category.id },
  });
  assert.equal(selfParent.status, 422);
  assert.equal(selfParent.payload.error.code, "INVALID_CATEGORY_PARENT");
  const serviceCycle = await request(`${categoriesA}/${root.payload.category.id}`, {
    method: "PATCH",
    token: tokenA,
    body: { name: "عطور", parentCategoryId: grandchild.payload.category.id },
  });
  assert.equal(serviceCycle.status, 422);
  assert.equal(serviceCycle.payload.error.code, "INVALID_CATEGORY_PARENT");

  // ---------- 2. cycles: DB trigger blocks raw SQL ----------
  let sqlCycleCode = null;
  try {
    await sql.query(
      "UPDATE product_categories SET parent_category_id = $1::uuid WHERE id = $2::uuid",
      [grandchild.payload.category.id, root.payload.category.id]
    );
  } catch (error) {
    sqlCycleCode = error?.code ?? null;
  }
  assert.equal(
    sqlCycleCode,
    "23514",
    "the cycle-guard trigger must refuse a circular parent chain written via raw SQL"
  );
  let sqlSelfCode = null;
  try {
    await sql.query(
      "UPDATE product_categories SET parent_category_id = $1::uuid WHERE id = $1::uuid",
      [child.payload.category.id]
    );
  } catch (error) {
    sqlSelfCode = error?.code ?? null;
  }
  assert.equal(sqlSelfCode, "23514");

  // ---------- 3. depth 4 rejected when re-parenting a subtree ----------
  const accessories = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "اكسسوارات" },
  });
  const accessoriesChild = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "ساعات", parentCategoryId: accessories.payload.category.id },
  });
  assert.equal(accessoriesChild.status, 201);
  const subtreeTooDeep = await request(`${categoriesA}/${accessories.payload.category.id}`, {
    method: "PATCH",
    token: tokenA,
    body: { name: "اكسسوارات", parentCategoryId: child.payload.category.id },
  });
  assert.equal(subtreeTooDeep.status, 422);
  assert.equal(
    subtreeTooDeep.payload.error.code,
    "CATEGORY_DEPTH_EXCEEDED",
    "moving a 2-level subtree under a level-2 parent would create level 4"
  );
  const validReparent = await request(`${categoriesA}/${accessoriesChild.payload.category.id}`, {
    method: "PATCH",
    token: tokenA,
    body: { name: "ساعات", parentCategoryId: root.payload.category.id },
  });
  assert.equal(validReparent.status, 200);
  assert.equal(validReparent.payload.category.parentCategoryId, root.payload.category.id);
  const reparentBack = await request(`${categoriesA}/${accessoriesChild.payload.category.id}`, {
    method: "PATCH",
    token: tokenA,
    body: { name: "ساعات", parentCategoryId: accessories.payload.category.id },
  });
  assert.equal(reparentBack.status, 200);

  // ---------- 4. cross-store parent rejected: API 404, raw SQL 23503 ----------
  const categoryB = await request(`/merchant/stores/${storeB.slug}/catalog/categories`, {
    method: "POST",
    token: tokenB,
    body: { name: "أثاث" },
  });
  assert.equal(categoryB.status, 201);
  const crossStoreParent = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "تسلل", parentCategoryId: categoryB.payload.category.id },
  });
  assert.equal(crossStoreParent.status, 404);
  assert.equal(crossStoreParent.payload.error.code, "CATEGORY_NOT_FOUND");
  let crossStoreFkCode = null;
  try {
    await sql.query(
      "INSERT INTO product_categories (store_id, name, normalized_name, parent_category_id) VALUES ($1::uuid, 'تسلل مباشر', 'تسلل مباشر', $2::uuid)",
      [storeA.id, categoryB.payload.category.id]
    );
  } catch (error) {
    crossStoreFkCode = error?.code ?? null;
  }
  assert.equal(
    crossStoreFkCode,
    "23503",
    "the composite same-store FK must refuse a parent from another store"
  );

  // ---------- 5. delete guards ----------
  const deleteParent = await request(`${categoriesA}/${root.payload.category.id}`, {
    method: "DELETE",
    token: tokenA,
  });
  assert.equal(deleteParent.status, 409);
  assert.equal(deleteParent.payload.error.code, "CATEGORY_HAS_CHILDREN");
  let restrictCode = null;
  try {
    await sql.query("DELETE FROM product_categories WHERE id = $1::uuid", [
      child.payload.category.id,
    ]);
  } catch (error) {
    restrictCode = error?.code ?? null;
  }
  assert.equal(
    restrictCode,
    "23503",
    "ON DELETE RESTRICT must also refuse raw SQL deletion of a parent with children"
  );
  const productInGrandchild = await prisma.product.create({
    data: {
      storeId: storeA.id,
      categoryId: grandchild.payload.category.id,
      sku: "CAT-NICHE-1",
      name: "عطر نيش",
      priceIqd: 45000,
      stockQuantity: 3,
      lowStockThreshold: 0,
    },
  });
  const deleteInUse = await request(`${categoriesA}/${grandchild.payload.category.id}`, {
    method: "DELETE",
    token: tokenA,
  });
  assert.equal(deleteInUse.status, 409);
  assert.equal(
    deleteInUse.payload.error.code,
    "CATEGORY_IN_USE",
    "the existing in-use guard is preserved"
  );
  const deletableLeaf = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "فرع مؤقت", parentCategoryId: root.payload.category.id },
  });
  const deleteLeaf = await request(`${categoriesA}/${deletableLeaf.payload.category.id}`, {
    method: "DELETE",
    token: tokenA,
  });
  // PG-2: the category delete became a SOFT delete and answers 200 with
  // { id, deletedAt, purgeAt } instead of a bare 204. The two 409 guards above
  // are unchanged — they are simply computed on LIVE rows now.
  assert.equal(deleteLeaf.status, 200, "an empty leaf category deletes normally");
  assert.ok(
    deleteLeaf.payload.deletedAt && deleteLeaf.payload.purgeAt,
    "PG-2: the soft delete reports its purge date"
  );

  // ---------- 6. storefront rollup ----------
  const productInRoot = await prisma.product.create({
    data: {
      storeId: storeA.id,
      categoryId: root.payload.category.id,
      sku: "CAT-ROOT-1",
      name: "عطر عام",
      priceIqd: 15000,
      stockQuantity: 5,
      lowStockThreshold: 0,
    },
  });
  const productInChild = await prisma.product.create({
    data: {
      storeId: storeA.id,
      categoryId: child.payload.category.id,
      sku: "CAT-MEN-1",
      name: "عطر رجالي",
      priceIqd: 25000,
      stockQuantity: 5,
      lowStockThreshold: 0,
    },
  });
  const byRoot = await request(
    `/store/${storeA.slug}/products?categoryId=${root.payload.category.id}`
  );
  assert.equal(byRoot.status, 200);
  assert.deepEqual(
    byRoot.payload.products.map((product) => product.id).sort(),
    [productInGrandchild.id, productInRoot.id, productInChild.id].sort(),
    "a parent filter must include every descendant category's products"
  );
  const byChild = await request(
    `/store/${storeA.slug}/products?categoryId=${child.payload.category.id}`
  );
  assert.deepEqual(
    byChild.payload.products.map((product) => product.id).sort(),
    [productInGrandchild.id, productInChild.id].sort()
  );
  const byGrandchild = await request(
    `/store/${storeA.slug}/products?categoryId=${grandchild.payload.category.id}`
  );
  assert.deepEqual(
    byGrandchild.payload.products.map((product) => product.id),
    [productInGrandchild.id]
  );

  // Parents whose products live only in descendants stay publicly visible.
  const shoes = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "أحذية" },
  });
  const shoesChild = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "أحذية رياضية", parentCategoryId: shoes.payload.category.id },
  });
  await prisma.product.create({
    data: {
      storeId: storeA.id,
      categoryId: shoesChild.payload.category.id,
      sku: "CAT-SNEAKER-1",
      name: "حذاء ركض",
      priceIqd: 30000,
      stockQuantity: 2,
      lowStockThreshold: 0,
    },
  });
  const publicCategoriesA = await request(`/store/${storeA.slug}/categories`);
  assert.equal(publicCategoriesA.status, 200);
  const publicIdsA = publicCategoriesA.payload.categories.map((category) => category.id);
  assert.equal(
    publicIdsA.includes(shoes.payload.category.id),
    true,
    "a parent with products only in its child must be publicly listed"
  );
  const publicChild = publicCategoriesA.payload.categories.find(
    (category) => category.id === child.payload.category.id
  );
  assert.equal(
    publicChild.parentCategoryId,
    root.payload.category.id,
    "public categories must expose parentCategoryId for nested rendering"
  );
  assert.equal(
    publicIdsA.includes(accessories.payload.category.id),
    false,
    "a subtree with no active products stays hidden publicly"
  );

  // No cross-store leak: store B never sees store A's tree, and filtering B by A's parent returns nothing.
  await prisma.product.create({
    data: {
      storeId: storeB.id,
      categoryId: categoryB.payload.category.id,
      sku: "CAT-B-1",
      name: "كرسي",
      priceIqd: 80000,
      stockQuantity: 4,
      lowStockThreshold: 0,
    },
  });
  const publicCategoriesB = await request(`/store/${storeB.slug}/categories`);
  assert.deepEqual(
    publicCategoriesB.payload.categories.map((category) => category.id),
    [categoryB.payload.category.id],
    "store B must list only its own categories"
  );
  const foreignFilter = await request(
    `/store/${storeB.slug}/products?categoryId=${root.payload.category.id}`
  );
  assert.equal(foreignFilter.status, 200);
  assert.deepEqual(
    foreignFilter.payload.products,
    [],
    "filtering store B by store A's category must return no products"
  );

  // ---------- 7. legacy flat categories unaffected ----------
  const flat = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "قهوة" },
  });
  assert.equal(flat.status, 201);
  const flatProduct = await prisma.product.create({
    data: {
      storeId: storeA.id,
      categoryId: flat.payload.category.id,
      sku: "CAT-FLAT-1",
      name: "قهوة مختصة",
      priceIqd: 12000,
      stockQuantity: 6,
      lowStockThreshold: 0,
    },
  });
  const byFlat = await request(
    `/store/${storeA.slug}/products?categoryId=${flat.payload.category.id}`
  );
  assert.deepEqual(
    byFlat.payload.products.map((product) => product.id),
    [flatProduct.id],
    "a flat category filter returns exactly its own products"
  );
  const flatPublic = (await request(`/store/${storeA.slug}/categories`)).payload.categories.find(
    (category) => category.id === flat.payload.category.id
  );
  assert.equal(flatPublic.parentCategoryId, null);
  const duplicateAcrossLevels = await request(categoriesA, {
    method: "POST",
    token: tokenA,
    body: { name: "  قهوة ", parentCategoryId: root.payload.category.id },
  });
  assert.equal(duplicateAcrossLevels.status, 409);
  assert.equal(
    duplicateAcrossLevels.payload.error.code,
    "DUPLICATE_CATEGORY",
    "normalized-name uniqueness stays store-wide, not per parent"
  );

  console.log(
    JSON.stringify(
      {
        nestedCreation: {
          levels: 3,
          parentInCreate: child.payload.category.parentCategoryId === root.payload.category.id,
          parentInList: listedChild.parentCategoryId === root.payload.category.id,
        },
        cycleGuards: {
          serviceSelf: selfParent.status,
          serviceCycle: serviceCycle.status,
          sqlCycleCode,
          sqlSelfCode,
        },
        depthGuards: {
          createDepth4: depth4.status,
          subtreeReparent: subtreeTooDeep.status,
          validReparent: validReparent.status,
        },
        crossStore: { apiParent: crossStoreParent.status, sqlParentFk: crossStoreFkCode },
        deleteGuards: {
          withChildren: deleteParent.status,
          sqlRestrict: restrictCode,
          inUse: deleteInUse.status,
          emptyLeaf: deleteLeaf.status,
        },
        storefrontRollup: {
          byRootCount: byRoot.payload.products.length,
          byChildCount: byChild.payload.products.length,
          byGrandchildCount: byGrandchild.payload.products.length,
          parentVisibleThroughChild: publicIdsA.includes(shoes.payload.category.id),
          storeBLeak: false,
        },
        legacyFlat: {
          filterExact: byFlat.payload.products.length === 1,
          storeWideUniqueness: duplicateAcrossLevels.status,
        },
      },
      null,
      2
    )
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
  await prisma.$disconnect();
}
