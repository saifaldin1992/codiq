-- ق-238 — صور المنتج تُصغَّر عند الرفع بدل أن تُقدَّم كما رفعها التاجر.
--
-- ثلاثة أعمدةٍ تقبل NULL، ولا شيءَ يُملأ رجعياً — وهذا مقصود:
-- الصفوف السابقة تحمل كائناً واحداً هو أصل التاجر، ولا نسخَ أصغر لها في الدلو.
-- عمودٌ يدّعي غير ذلك يجعل المسار يطلب مفتاحاً غير موجود فيردّ 404 على صورةٍ سليمة.
ALTER TABLE product_images ADD COLUMN variant_set INTEGER;
ALTER TABLE product_images ADD COLUMN width INTEGER;
ALTER TABLE product_images ADD COLUMN height INTEGER;

-- الأبعاد موجبةٌ أو غائبة. عرضٌ بصفرٍ يعني قسمةً على صفرٍ في حساب النسبة عند العميل.
ALTER TABLE product_images
  ADD CONSTRAINT product_images_dimensions_positive
  CHECK ((width IS NULL OR width > 0) AND (height IS NULL OR height > 0));

-- مجموعةُ نسخٍ معروفةٌ فقط. الرقم ١ هو {thumb 200 · card 800 · full 1600} webp.
ALTER TABLE product_images
  ADD CONSTRAINT product_images_variant_set_known
  CHECK (variant_set IS NULL OR variant_set = 1);

-- صفٌّ بمجموعةِ نسخٍ يعرف أبعاده. هذا ليس ترفاً: الأبعاد تُكتب في المعاملة نفسها
-- التي تكتب variant_set، فصفٌّ يحمل الأولى دون الثانية دليلُ كتابةٍ ناقصة لا حالةٌ صالحة.
ALTER TABLE product_images
  ADD CONSTRAINT product_images_variants_carry_dimensions
  CHECK (variant_set IS NULL OR (width IS NOT NULL AND height IS NOT NULL));
