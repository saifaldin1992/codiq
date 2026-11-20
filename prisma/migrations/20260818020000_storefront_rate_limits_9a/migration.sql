CREATE TABLE "storefront_rate_limits" (
  "scope" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "window_started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempt_count" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storefront_rate_limits_pkey" PRIMARY KEY ("scope", "key_hash"),
  CONSTRAINT "storefront_rate_limits_attempt_count_ck" CHECK ("attempt_count" > 0)
);

CREATE INDEX "storefront_rate_limits_updated_at_idx" ON "storefront_rate_limits"("updated_at");
