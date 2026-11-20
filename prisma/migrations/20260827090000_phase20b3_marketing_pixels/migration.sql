-- Phase 20B-3 — ad pixels (D-26). Purely additive: one new per-store settings
-- row in the notification_settings pattern (store_id UNIQUE FK, CASCADE).
-- Pixel ids are format-validated server-side (Meta ^[0-9]{5,20}$,
-- TikTok ^[A-Z0-9]{10,30}$, GA4 ^G-[A-Z0-9]{4,20}$) before any write, and the
-- public config re-validates on read; is_enabled defaults to OFF so nothing is
-- ever injected without an explicit merchant opt-in.

CREATE TABLE store_marketing_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
  meta_pixel_id text,
  tiktok_pixel_id text,
  ga4_measurement_id text,
  is_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
