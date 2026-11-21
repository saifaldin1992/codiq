-- Marketplace M12 — «البحث بالصورة».
--
-- One fingerprint per product, of its MAIN picture (the first by sort order):
-- 256 numbers describing colour, colour layout, edges and shape
-- (services/image-embedding.ts names the model, `codiq-visual-v1`). A shopper's
-- photo is turned into the same 256 numbers and the nearest products by cosine
-- distance are the answer — pgvector's HNSW index finds them without reading
-- every row.
--
-- `image_id` says which picture the row describes: when the merchant changes
-- the main picture the row no longer matches and the indexer redoes it; when
-- the picture is deleted the row goes with it. `model` lets a better
-- fingerprint replace this one later, product by product.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE product_image_embeddings (
  product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  image_id uuid NOT NULL REFERENCES product_images(id) ON DELETE CASCADE,
  model text NOT NULL,
  embedding vector(256) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_image_embeddings_model_known CHECK (length(model) BETWEEN 1 AND 40)
);

CREATE INDEX product_image_embeddings_hnsw ON product_image_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX product_image_embeddings_store_idx ON product_image_embeddings (store_id);
