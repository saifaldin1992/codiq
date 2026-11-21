-- Marketplace M0 — the geography and store facts a multi-store market needs.
-- Plan: docs/MARKETPLACE_PLAN.md §3 (م0). Nothing here changes how an existing
-- store, order or customer behaves: every new column is nullable or defaulted.
--
-- 1. districts — the area inside a governorate (القضاء / المنطقة). Stores and,
--    later, shopper addresses point at one. The governorate is stored on the
--    district too, so a composite foreign key can refuse «Kadhimiya, Basra».
-- 2. stores — what the market directory shows about a store: its business
--    type, cover image, where it is (governorate, district, coordinates) and
--    whether it hands orders over at its counter.
-- 3. store_opening_hours — one row per open weekday. A day with no row is
--    closed. Hours may cross midnight (18:00 → 02:00).

-- The eighteen keys of phase1-backend/src/services/governorates.ts.
-- market-foundation.integration.mjs fails if the two lists ever differ.
CREATE FUNCTION codiq_is_governorate_key(value TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT value IN ('Baghdad','Basra','Erbil','Al Anbar','Babylon','Dhi Qar','Diyala','Dohuk','Karbala',
                   'Kirkuk','Maysan','Muthanna','Najaf','Nineveh','Al-Qadisiyyah','Saladin','Sulaymaniyah','Wasit')
$$;

CREATE TABLE districts (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  governorate_key TEXT        NOT NULL,
  name_ar         TEXT        NOT NULL,
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT districts_governorate_known CHECK (codiq_is_governorate_key(governorate_key)),
  CONSTRAINT districts_name_present CHECK (length(btrim(name_ar)) BETWEEN 2 AND 60),
  CONSTRAINT districts_governorate_name_key UNIQUE (governorate_key, name_ar),
  -- Target of the composite FK from stores: a district is only valid inside its own governorate.
  CONSTRAINT districts_id_governorate_key UNIQUE (id, governorate_key)
);

ALTER TABLE stores
  ADD COLUMN business_type      TEXT,
  ADD COLUMN cover_object_key   TEXT,
  ADD COLUMN cover_content_type TEXT,
  ADD COLUMN cover_byte_size    INTEGER,
  ADD COLUMN governorate_key    TEXT,
  ADD COLUMN district_id        INTEGER,
  ADD COLUMN latitude           DOUBLE PRECISION,
  ADD COLUMN longitude          DOUBLE PRECISION,
  ADD COLUMN pickup_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT stores_cover_object_key_key UNIQUE (cover_object_key),
  ADD CONSTRAINT stores_business_type_length CHECK (business_type IS NULL OR length(btrim(business_type)) BETWEEN 2 AND 40),
  ADD CONSTRAINT stores_cover_complete CHECK (
    (cover_object_key IS NULL AND cover_content_type IS NULL AND cover_byte_size IS NULL)
    OR (cover_object_key IS NOT NULL AND cover_content_type IS NOT NULL AND cover_byte_size > 0)),
  ADD CONSTRAINT stores_governorate_known CHECK (governorate_key IS NULL OR codiq_is_governorate_key(governorate_key)),
  -- A district needs its governorate; the FK below then proves they agree.
  ADD CONSTRAINT stores_district_needs_governorate CHECK (district_id IS NULL OR governorate_key IS NOT NULL),
  ADD CONSTRAINT stores_district_in_governorate FOREIGN KEY (district_id, governorate_key)
    REFERENCES districts (id, governorate_key) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Both coordinates or neither, and only points on Earth.
  ADD CONSTRAINT stores_coordinates_pair CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT stores_coordinates_range CHECK (
    latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)),
  -- A counter pick-up needs a place to send the shopper to.
  ADD CONSTRAINT stores_pickup_needs_location CHECK (NOT pickup_enabled OR latitude IS NOT NULL);

CREATE INDEX stores_market_location_idx ON stores (governorate_key, district_id);

CREATE TABLE store_opening_hours (
  store_id   UUID     NOT NULL REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- 0 = Sunday … 6 = Saturday (JavaScript's getDay()), the Iraqi week starting Sunday.
  weekday    SMALLINT NOT NULL,
  opens_at   TIME(0)  NOT NULL,
  closes_at  TIME(0)  NOT NULL,
  PRIMARY KEY (store_id, weekday),
  CONSTRAINT store_opening_hours_weekday_range CHECK (weekday BETWEEN 0 AND 6),
  -- Equal times would mean «open for zero minutes» or «open all day»; neither is
  -- what a merchant means. All day is 00:00 → 23:59.
  CONSTRAINT store_opening_hours_not_empty CHECK (opens_at <> closes_at)
);

-- Seed: the districts a shopper picks from. The owner can add more later.
INSERT INTO districts (governorate_key, name_ar, sort_order)
SELECT g, d, ord FROM (VALUES
  ('Baghdad', ARRAY['الرصافة','الكرخ','الأعظمية','الكاظمية','مدينة الصدر','الكرادة','المنصور','الدورة','الشعب','اليرموك','بغداد الجديدة','الزعفرانية','الحرية','الغزالية','البياع','الشعلة','العامرية','السيدية','زيونة','الجادرية','الحسينية','التاجي','الطارمية','أبو غريب','المحمودية','المدائن']),
  ('Basra', ARRAY['مركز البصرة','العشار','الجبيلة','الزبير','أبو الخصيب','شط العرب','القرنة','المدينة','الهارثة','الدير','الفاو']),
  ('Erbil', ARRAY['مركز أربيل','عينكاوة','شقلاوة','سوران','كويسنجق','مخمور','ميركسور','جومان','خبات']),
  ('Al Anbar', ARRAY['الرمادي','الفلوجة','عامرية الفلوجة','الكرمة','هيت','حديثة','عانة','راوة','القائم','الرطبة']),
  ('Babylon', ARRAY['الحلة','المسيب','الإسكندرية','المحاويل','الهاشمية','القاسم','الكفل']),
  ('Dhi Qar', ARRAY['الناصرية','الشطرة','الرفاعي','سوق الشيوخ','الجبايش','الغراف','الدواية','النصر','الفهود']),
  ('Diyala', ARRAY['بعقوبة','المقدادية','الخالص','بلدروز','خانقين','كفري','بني سعد','جلولاء']),
  ('Dohuk', ARRAY['مركز دهوك','زاخو','سميل','العمادية','عقرة','الشيخان','بردرش']),
  ('Karbala', ARRAY['مركز كربلاء','الهندية','عين التمر','الحر']),
  ('Kirkuk', ARRAY['مركز كركوك','الحويجة','داقوق','الدبس']),
  ('Maysan', ARRAY['العمارة','علي الغربي','الكحلاء','المجر الكبير','قلعة صالح','الميمونة']),
  ('Muthanna', ARRAY['السماوة','الرميثة','الخضر','الوركاء','السلمان']),
  ('Najaf', ARRAY['مركز النجف','الكوفة','المناذرة','المشخاب']),
  ('Nineveh', ARRAY['الموصل','حمام العليل','القيارة','تلعفر','سنجار','الحمدانية','تلكيف','البعاج','الحضر']),
  ('Al-Qadisiyyah', ARRAY['الديوانية','عفك','الشامية','الحمزة','الدغارة','الشنافية','السنية']),
  ('Saladin', ARRAY['تكريت','سامراء','بيجي','الدور','بلد','الدجيل','الشرقاط','طوز خورماتو','العلم']),
  ('Sulaymaniyah', ARRAY['مركز السليمانية','رانية','جمجمال','دوكان','حلبجة','بنجوين','دربندخان','كلار','قلعة دزة']),
  ('Wasit', ARRAY['الكوت','الصويرة','الحي','النعمانية','العزيزية','بدرة','الزبيدية'])
) AS seed(g, names), unnest(names) WITH ORDINALITY AS t(d, ord);
