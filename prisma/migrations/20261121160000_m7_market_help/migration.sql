-- Marketplace M7a — what the shopper keeps and asks (docs/MARKETPLACE_PLAN.md S1–S5).
--
--   shopper_favourite_products / shopper_followed_stores   «المفضّلة»: products and stores
--   shopper_inbox_state / shopper_inbox_reads               the inbox's read marks. The inbox ITSELF
--                                                           is not a table: it is read from the order
--                                                           status history and the return decisions,
--                                                           so a notice can never be lost between a
--                                                           commit and a handler, and the money path
--                                                           is not edited to write one.
--   help_sections / help_articles                           FAQ, managed by the owner, searchable
--   market_contact_messages                                 «تواصل معنا»
--   market_app_feedback                                     «قيّم التطبيق»
--   market_settings                                         small owner-set values (support contacts)

CREATE TABLE shopper_favourite_products (
  shopper_id  UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  product_id  UUID NOT NULL,
  store_id    UUID NOT NULL,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (shopper_id, product_id),
  CONSTRAINT shopper_favourite_products_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX shopper_favourite_products_page_idx ON shopper_favourite_products (shopper_id, created_at DESC, product_id DESC);
CREATE INDEX shopper_favourite_products_product_idx ON shopper_favourite_products (product_id);

CREATE TABLE shopper_followed_stores (
  shopper_id  UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (shopper_id, store_id)
);
CREATE INDEX shopper_followed_stores_page_idx ON shopper_followed_stores (shopper_id, created_at DESC, store_id DESC);
CREATE INDEX shopper_followed_stores_store_idx ON shopper_followed_stores (store_id);

CREATE TABLE shopper_inbox_state (
  shopper_id    UUID PRIMARY KEY REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- «تحديد الكلّ كمقروء»: everything at or before this instant is read.
  read_all_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE TABLE shopper_inbox_reads (
  shopper_id  UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  item_key    TEXT NOT NULL,
  read_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (shopper_id, item_key),
  CONSTRAINT shopper_inbox_reads_key_shape CHECK (item_key ~ '^[a-z]:[0-9a-f-]{36}$')
);

CREATE TABLE help_sections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT help_sections_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 40),
  CONSTRAINT help_sections_title_length CHECK (char_length(title) BETWEEN 1 AND 80)
);
CREATE TABLE help_articles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id     UUID NOT NULL REFERENCES help_sections(id) ON DELETE CASCADE ON UPDATE CASCADE,
  question       TEXT NOT NULL,
  answer         TEXT NOT NULL,
  -- «حلول سريعة»: shown on top of the help page.
  is_quick       BOOLEAN NOT NULL DEFAULT false,
  is_published   BOOLEAN NOT NULL DEFAULT true,
  position       INTEGER NOT NULL DEFAULT 0,
  search_text    TEXT GENERATED ALWAYS AS (codiq_ar_normalize_v1(question || ' ' || answer)) STORED,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT help_articles_question_length CHECK (char_length(question) BETWEEN 3 AND 200),
  CONSTRAINT help_articles_answer_length CHECK (char_length(answer) BETWEEN 1 AND 4000)
);
CREATE INDEX help_articles_section_idx ON help_articles (section_id, position, id);

CREATE TABLE market_contact_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id     UUID REFERENCES shoppers(id) ON DELETE SET NULL ON UPDATE CASCADE,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new',
  handled_at     TIMESTAMPTZ(6),
  handled_note   TEXT,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_contact_messages_kind_known CHECK (kind IN ('suggestion', 'problem', 'question')),
  CONSTRAINT market_contact_messages_status_known CHECK (status IN ('new', 'handled')),
  CONSTRAINT market_contact_messages_lengths CHECK (char_length(name) BETWEEN 1 AND 80 AND char_length(body) BETWEEN 10 AND 2000 AND phone ~ '^\+9647[0-9]{9}$')
);
CREATE INDEX market_contact_messages_queue_idx ON market_contact_messages (status, created_at DESC, id DESC);

CREATE TABLE market_app_feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id  UUID REFERENCES shoppers(id) ON DELETE SET NULL ON UPDATE CASCADE,
  stars       SMALLINT NOT NULL,
  liked       TEXT[] NOT NULL DEFAULT '{}',
  note        TEXT,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_app_feedback_stars_range CHECK (stars BETWEEN 1 AND 5),
  CONSTRAINT market_app_feedback_liked_bounded CHECK (cardinality(liked) <= 10),
  CONSTRAINT market_app_feedback_note_length CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE INDEX market_app_feedback_page_idx ON market_app_feedback (created_at DESC, id DESC);
CREATE INDEX market_app_feedback_shopper_idx ON market_app_feedback (shopper_id, created_at DESC);

CREATE TABLE market_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT market_settings_key_shape CHECK (key ~ '^[a-z_]{1,40}$')
);

-- Starter help content; the owner edits it from the dashboard.
INSERT INTO help_sections (slug, title, position) VALUES
  ('orders', 'الطلبات', 1), ('payment', 'الدفع', 2), ('returns', 'الإرجاع والاسترداد', 3),
  ('problems', 'المشاكل', 4), ('points', 'النقاط والكوبونات', 5), ('account', 'الحساب', 6);
INSERT INTO help_articles (section_id, question, answer, is_quick, position)
SELECT s.id, a.question, a.answer, a.is_quick, a.position FROM (VALUES
  ('orders', 'كيف أتابع طلبي؟', 'افتح «طلباتي» من حسابك واختر الطلب لترى مرحلته الحاليّة وتاريخ كلّ مرحلة.', true, 1),
  ('orders', 'هل يمكنني إلغاء الطلب؟', 'نعم، ما دام المتجر لم يقبل الطلب بعد. افتح الطلب واضغط «إلغاء الطلب» واختر السبب.', true, 2),
  ('orders', 'ما هو رمز الاستلام؟', 'أربعة أرقام تظهر في صفحة الطلب بعد قبوله. أعطها للمندوب أو لموظّف المتجر عند الاستلام فقط.', false, 3),
  ('payment', 'ما طرق الدفع المتاحة؟', 'الدفع نقداً عند الاستلام متاح في كلّ المتاجر، وبعض المتاجر تقبل طرقاً أخرى تظهر عند إتمام الطلب.', true, 1),
  ('payment', 'لماذا تختلف رسوم التوصيل بين المتاجر؟', 'كلّ متجر يحدّد رسوم توصيله لكلّ محافظة، وتظهر الرسوم قبل تأكيد الطلب.', false, 2),
  ('returns', 'كيف أطلب إرجاع منتج؟', 'افتح الطلب بعد استلامه واضغط «طلب إرجاع» واختر السبب. يراجع المتجر الطلب ويردّ عليك.', true, 1),
  ('returns', 'كم مدّة الإرجاع؟', 'يمكنك طلب الإرجاع خلال المدّة المذكورة في صفحة الطلب بعد استلامه.', false, 2),
  ('problems', 'وصلني منتج تالف، ماذا أفعل؟', 'اطلب إرجاعه من صفحة الطلب واختر «وصل تالفاً»، أو افتح تذكرة دعم من الطلب.', true, 1),
  ('problems', 'لم يصلني رمز الدخول', 'تأكّد من الرقم وانتظر دقيقة ثمّ اطلب الرمز من جديد.', false, 2),
  ('points', 'كيف أستخدم كوبون الخصم؟', 'اكتب الكوبون في صفحة إتمام الطلب واضغط «تطبيق» قبل تأكيد الطلب.', false, 1),
  ('account', 'كيف أغيّر عنواني؟', 'من «حسابي» ثمّ «العناوين» يمكنك إضافة عنوان أو تعديله أو جعله الافتراضيّ.', false, 1)
) AS a(section, question, answer, is_quick, position)
JOIN help_sections s ON s.slug = a.section;
