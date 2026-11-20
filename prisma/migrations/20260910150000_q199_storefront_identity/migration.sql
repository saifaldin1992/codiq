-- ق-199 — everything a merchant may say about his own storefront, in one place.
--
-- The storefront had one merchant-authored sentence (the vacation message) and
-- nothing else: the header printed the URL slug where the shop's name belongs,
-- there was no logo, no announcement strip, no contact block, no social links,
-- no written policies, and no switch for whether a stranger may buy without an
-- account. Each of those is a thing that differs from shop to shop, so each is
-- a column here — on `stores`, not a side table, because there is exactly one
-- of each per store and a join would buy nothing.
--
-- THE RULE THESE COLUMNS SERVE: every field is edited from ONE merchant screen
-- («واجهة المتجر») and read by ONE public payload (GET /store/:slug/public-config).
-- A guard (storefront-config.guard.mjs) holds the two lists equal, so a field
-- can never exist that the merchant can set and the shopper never sees.
ALTER TABLE stores
  -- Identity. The logo rides the same object store, magic-byte validator and
  -- plan meter as product images; the three columns are set together or not
  -- at all (CHECK below), because a key without a type is unservable.
  ADD COLUMN logo_object_key TEXT,
  ADD COLUMN logo_content_type TEXT,
  ADD COLUMN logo_byte_size INTEGER,
  -- The two lines under the front-page slider. Optional: the name stands alone.
  ADD COLUMN headline TEXT,
  ADD COLUMN subline TEXT,
  -- The announcement strip above the header. Off by default; on requires text.
  ADD COLUMN announcement_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN announcement_text TEXT,
  -- Contact (P27-2 §1). `support_email` also becomes Reply-To on the store's
  -- mail to its own customers (ق-184), so a shopper's reply reaches the shop.
  ADD COLUMN support_email TEXT,
  ADD COLUMN support_phone TEXT,
  ADD COLUMN support_whatsapp TEXT,
  ADD COLUMN address_line TEXT,
  ADD COLUMN city TEXT,
  -- Social handles (P27-2 §2): USERNAMES ONLY, never a free URL. The prefix is
  -- fixed in code, so a handle can never carry a scheme, a host or a script.
  ADD COLUMN social_facebook TEXT,
  ADD COLUMN social_instagram TEXT,
  ADD COLUMN social_x TEXT,
  ADD COLUMN social_tiktok TEXT,
  -- Written policies (P27-2 §3): the store's own, optional ON TOP of the
  -- platform's mandatory ones (PG-9). Plain text; rendered as paragraphs.
  ADD COLUMN policy_return TEXT,
  ADD COLUMN policy_privacy TEXT,
  ADD COLUMN policy_delivery TEXT,
  -- Guest checkout. ON by default: the owner's instruction is that registration
  -- is optional, and a default that quietly turned buyers away would be the
  -- one nobody notices until the sales are gone.
  ADD COLUMN guest_checkout_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Which front-page sections show, in what order, under what title. An empty
  -- array means «the defaults» — the shape is fixed by a zod schema in code.
  ADD COLUMN home_sections JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE stores
  ADD CONSTRAINT stores_logo_object_key_key UNIQUE (logo_object_key),
  ADD CONSTRAINT stores_logo_columns_together CHECK (
    (logo_object_key IS NULL) = (logo_content_type IS NULL)
    AND (logo_object_key IS NULL) = (logo_byte_size IS NULL)
  ),
  -- A byte size of zero would make the plan meter lie, exactly as for images.
  ADD CONSTRAINT stores_logo_byte_size_positive CHECK (logo_byte_size IS NULL OR logo_byte_size > 0),
  ADD CONSTRAINT stores_announcement_text_when_on CHECK (NOT announcement_enabled OR announcement_text IS NOT NULL),
  -- E.164, digits only after the plus. Validated in zod too; one site would
  -- leave the other as the way in.
  ADD CONSTRAINT stores_support_phone_e164 CHECK (support_phone IS NULL OR support_phone ~ '^\+[0-9]{8,15}$'),
  ADD CONSTRAINT stores_support_whatsapp_e164 CHECK (support_whatsapp IS NULL OR support_whatsapp ~ '^\+[0-9]{8,15}$'),
  ADD CONSTRAINT stores_social_handles_are_usernames CHECK (
    (social_facebook IS NULL OR social_facebook ~ '^[A-Za-z0-9._-]{1,60}$')
    AND (social_instagram IS NULL OR social_instagram ~ '^[A-Za-z0-9._]{1,30}$')
    AND (social_x IS NULL OR social_x ~ '^[A-Za-z0-9_]{1,15}$')
    AND (social_tiktok IS NULL OR social_tiktok ~ '^[A-Za-z0-9._]{1,24}$')
  ),
  ADD CONSTRAINT stores_home_sections_is_array CHECK (jsonb_typeof(home_sections) = 'array');

-- Typed attributes on a product («النوتة العطرية»: مقدمة / قلب / قاعدة). A list of
-- groups, each a label and its key/value rows — the group label is the
-- merchant's own vocabulary, so it lives in the data and not in a component.
-- The shape is fixed by a zod schema; the CHECK only refuses a non-array.
ALTER TABLE products
  ADD COLUMN attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT products_attributes_is_array CHECK (jsonb_typeof(attributes) = 'array');
