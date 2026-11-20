# مراجعة OWASP ASVS 5.0 — المستوى 2

**التاريخ:** 2026-11-20 · **المعيار:** [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/tree/v5.0.0) — القائمة الرسميّة (CSV من الوسم `v5.0.0`)، كلّ متطلّبات المستويين 1 و2 (253 بنداً).

**المنهج:** كلّ بند قُيّم مقابل **الشيفرة** — بقراءة الملفّ المعنيّ أو بتجربةٍ مقيسة — لا مقابل الوثائق. ما وُجد ناقصاً وأمكن إصلاحه دون قرار مالك أُصلح في هذه المراجعة نفسها وعليه اختبار.

> **حدود هذه المراجعة:** مراجعة شيفرة وتشغيل على بيئة محلّيّة، لا اختبار اختراق على نشرٍ حقيقيّ، ولا شهادة. اختبار الاختراق المستقلّ يبقى مطلوباً قبل الإطلاق العامّ.

## ١. الخلاصة

| | العدد |
|---|---:|
| ✅ مستوفى | 147 |
| ✅🔧 أُصلح في هذه المراجعة (مستوفى الآن) | 17 |
| 🟡 جزئيّ | 23 |
| ❌ غير مستوفى | 5 |
| ➖ لا ينطبق | 61 |
| **المستوفى من المنطبق** | **164 من 192 (85%)** |

### حسب الفصل

| الفصل | ✅ | ✅🔧 | 🟡 | ❌ | ➖ |
|---|---:|---:|---:|---:|---:|
| V1 Encoding and Sanitization | 18 | 2 | 0 | 0 | 7 |
| V2 Validation and Business Logic | 8 | 0 | 3 | 0 | 0 |
| V3 Web Frontend Security | 15 | 1 | 3 | 0 | 0 |
| V4 API and Web Service | 3 | 0 | 1 | 0 | 6 |
| V5 File Handling | 7 | 0 | 0 | 1 | 1 |
| V6 Authentication | 22 | 3 | 2 | 1 | 7 |
| V7 Session Management | 11 | 0 | 3 | 1 | 3 |
| V8 Authorization | 5 | 0 | 2 | 0 | 0 |
| V9 Self-contained Tokens | 7 | 0 | 0 | 0 | 0 |
| V10 OAuth and OIDC | 0 | 0 | 0 | 0 | 29 |
| V11 Cryptography | 12 | 1 | 1 | 0 | 0 |
| V12 Secure Communication | 6 | 0 | 2 | 0 | 1 |
| V13 Configuration | 10 | 1 | 0 | 2 | 0 |
| V14 Data Protection | 4 | 2 | 3 | 0 | 0 |
| V15 Secure Coding and Architecture | 9 | 4 | 0 | 0 | 0 |
| V16 Security Logging and Error Handling | 10 | 3 | 3 | 0 | 0 |
| V17 WebRTC | 0 | 0 | 0 | 0 | 7 |

## ٢. ما أُصلح في هذه المراجعة

| البند | العيب | الدليل |
|---|---|---|
| V6.2.8 | **ثغرة حقيقيّة:** bcrypt يتجاهل ما بعد 72 بايتاً، فكلمة مرور مختلفة تشترك في أوّل 36 حرفاً عربيّاً كانت تفتح الحساب (مُثبَت) | `password:hash` يفشل على الشيفرة القديمة |
| V6.2.4/12 | قائمة الكلمات الشائعة 160 فقط؛ صارت تشمل أشهر 10,000 كلمة مسرّبة (خادميّاً فقط) | `password:policy` |
| V16.3.1–3 | محاولات الدخول الفاشلة والرفض الأمنيّ لم تكن تُسجَّل في الإنتاج | `logging:guard` |
| V3.4.1 | HSTS بلا includeSubDomains على نطاق المنصّة (صار له، ولنطاقات التجّار الخاصّة لا) | `headers:guard` |
| V1.4.2 | سعرٌ أو مجموعٌ يتجاوز int32 كان يُسقط الطلب بـ500 | تحقّق zod + رفض ORDER_TOTAL_TOO_LARGE |
| V15.3.2 | طلبات مزوّد البريد كانت تتبع إعادة التوجيه ومعها مفتاح API | `redirect: "error"` |
| V15.2.1 | 1 حرجة + 7 عالية في الاعتماديّات | `pnpm audit --audit-level=high` نظيف |
| V15.1.2 | لا SBOM | CycloneDX في CI |
| V1.3.2 | لا حارس آليّاً ضدّ eval | ESLint في CI |
| — | شيفرة OAuth ميّتة من القالب الأصليّ ترسل المستخدم إلى بوّابة خارجيّة | حُذفت |
| V11.1.2 · V13.1.1 · V14.1 | لا جرد تشفير ولا جرد اتّصالات ولا تصنيف بيانات | القسم ٤ أدناه |

## ٣. ما بقي — مرتّباً بالأولويّة

| البند | الحالة | ما المطلوب | قرار مالك؟ |
|---|---|---|---|
| V6.3.3 | ❌ | مصادقة ثنائيّة للتجّار وطاقم المتاجر (البنية موجودة للمالك وطاقم المنصّة — تُمدَّد) | نعم: إلزاميّة أم اختياريّة؟ |
| V7.3.1 | ❌ | مهلة خمول للجلسات (`lastSeenAt` مسجّل ولا يُطبَّق) | نعم: كم دقيقة لكلّ هويّة؟ |
| V13.2.4/5 | ❌ | قائمة سماح للاتّصالات الخارجة من الحاوية (`allowedHosts` في Cloudflare Containers) | لا — عند النشر الأوّل |
| V5.4.3 | ❌ | فحص الملفّات المرفوعة بمضادّ فيروسات (الصور يعاد ترميزها؛ الوصفات الطبّيّة لا) | نعم: كلفة الخدمة |
| V14.2.3 | 🟡 | مراجعة ما تُرسله بكسلات التسويق للتأكّد من خلوّه من بيانات شخصيّة | لا |
| V16.4.2/3 | 🟡 | إرسال السجلّات إلى مخزنٍ منفصل محميّ (Cloudflare Logpush أو ما يماثله) | لا — عند النشر |
| V3.3.1/3 | 🟡 | كعكات الزبون بلا بادئة __Host- (مقصود: عزل كلّ متجر بمساره) | قبول موثّق |
| V3.5.4 | 🟡 | فصل لوحات التحكّم على نطاقٍ فرعيّ (مثل app.) عن واجهات المتاجر | نعم: تغيير بنية النطاقات |
| V7.4.5 · V7.5.2 | 🟡 | إنهاء جلسةٍ بعينها من لوحة المالك، وطلب إعادة المصادقة قبل إنهاء الجلسات | لا |
| V6.1.2/V6.2.11 | 🟡 | منع كلمات سياقيّة لكلّ متجر (اسم المتجر نفسه) | لا |
| V2.1 · V8.1.2 · V11.1.1 · V16.1.1 | 🟡 | وثائق قائمة بذاتها (قواعد التحقّق، صلاحيّات الحقول، دورة المفاتيح، جرد السجلّات) — المضمون موجود في الشيفرة | لا |

## ٤. الجرود التي يطلبها المعيار

### جرد التشفير (V11.1.2)

| الاستعمال | الخوارزمية | المفتاح ومصدره | التدوير |
|---|---|---|---|
| كلمات المرور ورموز الاستعادة | bcrypt كلفة 12؛ فوق 72 بايتاً: bcrypt(base64(SHA-256)) | — | إعادة التجزئة عند تغيير كلمة المرور |
| رموز الجلسات | JWT HS256 + صفّ جلسة بتجزئة الرمز | `SESSION_JWT_SECRET` (مشتقّ بـHKDF) | `SESSION_JWT_SECRET_PREVIOUS` |
| أسرار مخزّنة (TOTP، مفتاح مزوّد البريد) | AES-256-GCM، مفتاح مشتقّ بـHKDF-SHA256 لكلّ غرض | `CODIQ_ENCRYPTION_KEY` | `CODIQ_ENCRYPTION_KEY_PREVIOUS` + `secrets:encrypt` |
| النسخ الاحتياطيّة | AES-256-GCM في مغلّف CODIQBK1 | `CODIQ_BACKUP_ENCRYPTION_KEY` (لدى مهمّة النسخ وحدها) | `…_PREVIOUS` |
| توقيع webhook البريد | HMAC-SHA256 (Svix)، مقارنة ثابتة الزمن | `CODIQ_RESEND_WEBHOOK_SECRET` | من لوحة المزوّد |
| روابط إلغاء الاشتراك | HMAC، مقارنة ثابتة الزمن | مشتقّ من مفتاح الجلسات | مع مفتاح الجلسات |
| رموز الاستعادة وTOTP | CSPRNG (`crypto.randomBytes`)، RFC 6238 | — | — |

### جرد الاتّصالات (V13.1.1)

| من | إلى | البروتوكول | الاعتماد |
|---|---|---|---|
| المتصفّح | Cloudflare (CDN/WAF) | HTTPS | كعكة جلسة HttpOnly |
| Cloudflare Worker | الحاوية (الخادم + العامل) | داخل شبكة Cloudflare | — |
| الخادم والعامل | PostgreSQL (Supabase) | TLS | `CODIQ_POSTGRES_URL` |
| الخادم | تخزين الصور (R2/S3) | HTTPS | `PRODUCT_S3_*` |
| العامل | مزوّد البريد (Resend أو SMTP) | HTTPS/SMTP+TLS | `CODIQ_RESEND_API_KEY` / `CODIQ_SMTP_*` |
| مزوّد البريد | الخادم (webhook) | HTTPS | توقيع HMAC |
| الخادم | Sentry | HTTPS | `SENTRY_DSN` |
| مهمّة النسخ (GitHub Actions) | PostgreSQL ← حاوية النسخ (R2) | TLS/HTTPS | `SUPABASE_DB_URL_DIRECT` · `CODIQ_BACKUP_S3_*` |

### تصنيف البيانات (V14.1)

| الصنف | أمثلة | الحماية |
|---|---|---|
| **حسّاس جدّاً** | الوصفات الطبّيّة، أسرار TOTP، مفاتيح المزوّدين | تخزين خاصّ غير عامّ، تشفير الأسرار، `no-store`، صلاحيّة صريحة، لا تُسجَّل |
| **شخصيّ** | أسماء الزبائن، الهواتف، العناوين، البريد | عزل المستأجر في القاعدة، `no-store`، تنقيح في السجلّات، احتفاظ محدود |
| **ماليّ** | الدفتر، التسويات، المحافظ | جداول append-only، صلاحيّات المال، تدقيق |
| **اعتماد** | كلمات المرور، الجلسات، رموز الاستعادة | تجزئة فقط، لا تُسجَّل، تُلغى عند التغيير |
| **عامّ** | الكتالوج، صفحات المتجر | قابل للتخزين على الحافّة |

## ٥. كلّ البنود


### V1 — Encoding and Sanitization

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V1.1.1 | 2 | ✅ | JSON bodies parsed once by express.json; zod validates the parsed value; no double decoding. |
| V1.1.2 | 2 | ✅ | React escapes on render; server SEO shell escapes every interpolated value (brand:test proves it). |
| V1.2.1 | 1 | ✅ | React text rendering; JSON via res.json; storefront-seo escapes HTML and JSON-LD contexts. |
| V1.2.2 | 1 | ✅ | encodeURIComponent on dynamic URL segments (client APIs, reset links). |
| V1.2.3 | 1 | ✅ | React text rendering; JSON via res.json; storefront-seo escapes HTML and JSON-LD contexts. |
| V1.2.4 | 1 | ✅ | Prisma ORM; raw SQL uses Prisma.sql tagged templates (bound parameters); the one $queryRawUnsafe runs EXPLAIN on the engine's own statement with bound values. |
| V1.2.5 | 1 | ✅ | Only fixed-argument spawns (worker process; pg_dump in the backup job) — no shell, no user input. |
| V1.2.6 | 2 | ➖ | No LDAP, XPath, LaTeX, JNDI or memcache. |
| V1.2.7 | 2 | ➖ | No LDAP, XPath, LaTeX, JNDI or memcache. |
| V1.2.8 | 2 | ➖ | No LDAP, XPath, LaTeX, JNDI or memcache. |
| V1.2.9 | 2 | ✅ | Search uses pg_trgm on normalized text, not user-built regular expressions. |
| V1.3.1 | 1 | ✅ | No rich-text/HTML input: merchant pages and policies render as plain text paragraphs. |
| V1.3.2 | 1 | ✅🔧 | No eval/new Function anywhere; now enforced by ESLint (no-eval, no-implied-eval, no-new-func) in CI. |
| V1.3.3 | 2 | ✅ | zod at every write; slug/code patterns are allowlists. |
| V1.3.4 | 2 | ✅ | Uploaded SVG logo served as attachment with CSP default-src 'none' and nosniff (public.ts); images re-encoded by sharp. |
| V1.3.5 | 2 | ✅ | No Markdown/CSS/XSL rendering of user content. |
| V1.3.6 | 2 | ✅ | Server fetches only the configured mail provider endpoint; no user-supplied URL is fetched. |
| V1.3.7 | 2 | ✅ | No server-side template engine; the SEO shell is filled by escaped string replacement. |
| V1.3.8 | 2 | ➖ | No LDAP, XPath, LaTeX, JNDI or memcache. |
| V1.3.9 | 2 | ➖ | No LDAP, XPath, LaTeX, JNDI or memcache. |
| V1.3.10 | 2 | ✅ | No printf-style formatting of user input. |
| V1.3.11 | 2 | ✅ | Mail sent through nodemailer/Resend JSON APIs; headers are not built from raw user strings. |
| V1.4.1 | 2 | ➖ | Managed runtime (Node.js); no manual memory management. |
| V1.4.2 | 2 | ✅🔧 | Prices/stock bounded to int32 at the edge; checkout refuses totals that would overflow (ORDER_TOTAL_TOO_LARGE). |
| V1.4.3 | 2 | ➖ | Managed runtime (Node.js); no manual memory management. |
| V1.5.1 | 1 | ✅ | No XML parsing of untrusted input (the S3 SDK parses responses from the configured store only). |
| V1.5.2 | 2 | ✅ | Only JSON is deserialized; zod object schemas drop unknown keys. |

### V2 — Validation and Business Logic

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V2.1.1 | 1 | 🟡 | Rules live in zod schemas and service code with extensive comments and docs/openapi.json; no single standalone validation document. |
| V2.1.2 | 2 | 🟡 | Rules live in zod schemas and service code with extensive comments and docs/openapi.json; no single standalone validation document. |
| V2.1.3 | 2 | 🟡 | Plan limits, rate limits and caps are documented in code/ADRs (ADR-005) rather than one business-limits document. |
| V2.2.1 | 1 | ✅ | Server-side validation for every write (validation:guard enforces it); combinations checked in services (e.g. settlement contiguity, coupon rules). |
| V2.2.2 | 1 | ✅ | Server-side validation for every write (validation:guard enforces it); combinations checked in services (e.g. settlement contiguity, coupon rules). |
| V2.2.3 | 2 | ✅ | Server-side validation for every write (validation:guard enforces it); combinations checked in services (e.g. settlement contiguity, coupon rules). |
| V2.3.1 | 1 | ✅ | Order state machine with allowed transitions and optimistic version checks; checkout idempotency keys. |
| V2.3.2 | 2 | ✅ | Plan limits enforced server-side (assertWithinPlanLimit), including the staff-reactivation path fixed in this review. |
| V2.3.3 | 2 | ✅ | Money, stock and orders change inside one transaction (Serializable where it matters) with retry. |
| V2.3.4 | 2 | ✅ | Stock reservations and compare-and-set updates (inventory:cas proves no oversell). |
| V2.4.1 | 2 | ✅ | Per-scope rate limits (DB-backed for auth/checkout, in-memory for the visit beacon). |

### V3 — Web Frontend Security

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V3.2.1 | 1 | ✅ | Correct Content-Type on every response; nosniff everywhere; uploaded bytes served with fixed types. |
| V3.2.2 | 1 | ✅ | React renders text; no dangerouslySetInnerHTML in the client. |
| V3.3.1 | 1 | 🟡 | Dashboard cookie is __Host- and Secure in production; storefront customer cookies are Secure but path-scoped per store, so the __Host- prefix (which forces Path=/) cannot be used — by design (cookie isolation between stores). |
| V3.3.2 | 2 | ✅ | SameSite=Lax on every cookie. |
| V3.3.3 | 2 | 🟡 | As V3.3.1: __Host- on the dashboard cookie; per-store path scoping instead for storefront cookies. |
| V3.3.4 | 2 | ✅ | HttpOnly on every session cookie. |
| V3.4.1 | 1 | ✅🔧 | HSTS one year; includeSubDomains now on the platform host and its subdomains (not on merchants' custom domains, deliberately). |
| V3.4.2 | 1 | ✅ | No CORS headers (same-origin only); writes require a trusted Origin/Sec-Fetch-Site (csrf:guard). |
| V3.4.3 | 2 | ✅ | Content-Security-Policy per surface (security-headers.ts, headers:guard). |
| V3.4.4 | 2 | ✅ | nosniff, strict-origin-when-cross-origin, frame-ancestors 'none' on every response. |
| V3.4.5 | 2 | ✅ | nosniff, strict-origin-when-cross-origin, frame-ancestors 'none' on every response. |
| V3.4.6 | 2 | ✅ | nosniff, strict-origin-when-cross-origin, frame-ancestors 'none' on every response. |
| V3.5.1 | 1 | ✅ | No CORS headers (same-origin only); writes require a trusted Origin/Sec-Fetch-Site (csrf:guard). |
| V3.5.2 | 1 | ✅ | No CORS headers (same-origin only); writes require a trusted Origin/Sec-Fetch-Site (csrf:guard). |
| V3.5.3 | 1 | ✅ | State changes only via POST/PUT/PATCH/DELETE. |
| V3.5.4 | 2 | 🟡 | Merchant custom domains and store subdomains are separate origins; on the platform apex, storefront paths share the origin with the dashboards (mitigated by CSP and path-scoped cookies). |
| V3.5.5 | 2 | ✅ | No postMessage handlers. |
| V3.7.1 | 2 | ✅ | Current React 19/Vite; no deprecated client technologies. |
| V3.7.2 | 2 | ✅ | No redirects to external hosts. |

### V4 — API and Web Service

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V4.1.1 | 1 | ✅ | res.json / explicit content types; generated OpenAPI documents them. |
| V4.1.2 | 2 | 🟡 | HTTP→HTTPS redirect is the edge's job (Cloudflare 'Always Use HTTPS'); document in deployment guide. |
| V4.1.3 | 2 | ✅ | Client IP read from the edge header only when CODIQ_TRUSTED_EDGE names the edge (client-ip.ts). |
| V4.2.1 | 2 | ✅ | Node/Express HTTP parser behind one edge; no custom framing. |
| V4.3.1 | 2 | ➖ | No GraphQL, no WebSockets. |
| V4.3.2 | 2 | ➖ | No GraphQL, no WebSockets. |
| V4.4.1 | 1 | ➖ | No GraphQL, no WebSockets. |
| V4.4.2 | 2 | ➖ | No GraphQL, no WebSockets. |
| V4.4.3 | 2 | ➖ | No GraphQL, no WebSockets. |
| V4.4.4 | 2 | ➖ | No GraphQL, no WebSockets. |

### V5 — File Handling

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V5.1.1 | 2 | ✅ | Per-upload types and sizes defined in code and pinned by upload:limits guard. |
| V5.2.1 | 1 | ✅ | multer size limits per route; images re-encoded with dimension caps. |
| V5.2.2 | 1 | ✅ | Content verified by decoding (sharp) / magic bytes, not by extension. |
| V5.2.3 | 2 | ➖ | No archive uploads (CSV import is plain text with size limit). |
| V5.3.1 | 1 | ✅ | Uploads live in object storage, never executed; served with nosniff. |
| V5.3.2 | 1 | ✅ | Object keys are server-generated UUIDs; client filenames ignored. |
| V5.4.1 | 2 | ✅ | Object keys are server-generated UUIDs; client filenames ignored. |
| V5.4.2 | 2 | ✅ | Fixed Content-Disposition filenames. |
| V5.4.3 | 2 | ❌ | No antivirus scan. Images are re-encoded (neutralizes most payloads) but prescription uploads are stored as received. |

### V6 — Authentication

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V6.1.1 | 1 | ✅ | Rate limits and constant-time sign-in (ABSENT_IDENTITY_HASH) documented in code and docs. |
| V6.1.2 | 2 | 🟡 | Context words (platform name, 'store', 'shop'…) are in the curated list; no per-tenant words (store name) yet. |
| V6.1.3 | 2 | ✅ | Five identities, each with one sign-in door, listed in ARCHITECTURE.md and the OpenAPI document. |
| V6.2.1 | 1 | ✅ | Minimum 8, change-password needs current password, no composition rules, no forced rotation. |
| V6.2.2 | 1 | ✅ | Minimum 8, change-password needs current password, no composition rules, no forced rotation. |
| V6.2.3 | 1 | ✅ | Minimum 8, change-password needs current password, no composition rules, no forced rotation. |
| V6.2.4 | 1 | ✅🔧 | Curated list plus the SecLists 10k most common (breached) passwords, server-side (password:policy). |
| V6.2.5 | 1 | ✅ | Minimum 8, change-password needs current password, no composition rules, no forced rotation. |
| V6.2.6 | 1 | ✅ | type=password with an explicit show toggle; paste and managers allowed. |
| V6.2.7 | 1 | ✅ | type=password with an explicit show toggle; paste and managers allowed. |
| V6.2.8 | 1 | ✅🔧 | Fixed in this review: bcrypt's 72-byte truncation let a different long password sign in; long passwords are now pre-hashed (password:hash proves it). |
| V6.2.9 | 2 | ✅ | Up to 200 characters accepted. |
| V6.2.10 | 2 | ✅ | Minimum 8, change-password needs current password, no composition rules, no forced rotation. |
| V6.2.11 | 2 | 🟡 | Context words (platform name, 'store', 'shop'…) are in the curated list; no per-tenant words (store name) yet. |
| V6.2.12 | 2 | ✅🔧 | Curated list plus the SecLists 10k most common (breached) passwords, server-side (password:policy). |
| V6.3.1 | 1 | ✅ | Rate limits + per-account failure counters on every sign-in door. |
| V6.3.2 | 1 | ✅ | No default accounts; the first owner is created interactively (owner:create). |
| V6.3.3 | 2 | ❌ | MFA (TOTP) exists for the platform owner and platform staff only. Merchants, store staff and customers sign in with a password alone. |
| V6.3.4 | 2 | ✅ | Five identities, each with one sign-in door, listed in ARCHITECTURE.md and the OpenAPI document. |
| V6.4.1 | 1 | ✅ | Passwords set by an operator are marked provisional and must be changed before use (merchants ق-218, staff fixed in this review). |
| V6.4.2 | 1 | ✅ | No hints or secret questions. |
| V6.4.3 | 2 | ✅ | Password reset never disables or bypasses TOTP (documented in password-reset.service.ts). |
| V6.4.4 | 2 | ✅ | Lost TOTP: single-use recovery codes, or an owner reset with audit trail. |
| V6.5.1 | 2 | ✅ | TOTP steps are single-use (totpLastStep), seeds from crypto CSPRNG, 30-second window. |
| V6.5.2 | 2 | ✅ | Recovery codes are random and stored bcrypt-hashed. |
| V6.5.3 | 2 | ✅ | TOTP steps are single-use (totpLastStep), seeds from crypto CSPRNG, 30-second window. |
| V6.5.4 | 2 | ✅ | Recovery codes are random and stored bcrypt-hashed. |
| V6.5.5 | 2 | ✅ | TOTP steps are single-use (totpLastStep), seeds from crypto CSPRNG, 30-second window. |
| V6.6.1 | 2 | ➖ | No SMS/phone or out-of-band authentication. |
| V6.6.2 | 2 | ➖ | No SMS/phone or out-of-band authentication. |
| V6.6.3 | 2 | ➖ | No SMS/phone or out-of-band authentication. |
| V6.8.1 | 2 | ➖ | No external identity providers or SAML. |
| V6.8.2 | 2 | ➖ | No external identity providers or SAML. |
| V6.8.3 | 2 | ➖ | No external identity providers or SAML. |
| V6.8.4 | 2 | ➖ | No external identity providers or SAML. |

### V7 — Session Management

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V7.1.1 | 2 | 🟡 | Absolute lifetime (8 h) documented; no inactivity timeout to document (see V7.3.1). |
| V7.1.2 | 2 | ✅ | Concurrent sessions allowed and visible/revocable per user (sessions screen). |
| V7.1.3 | 2 | ➖ | No federated identity / SSO. |
| V7.2.1 | 1 | ✅ | HS256 JWT bound to a server-side session row (token hash) checked on every request. |
| V7.2.2 | 1 | ✅ | HS256 JWT bound to a server-side session row (token hash) checked on every request. |
| V7.2.3 | 1 | ✅ | HS256 JWT bound to a server-side session row (token hash) checked on every request. |
| V7.2.4 | 1 | ✅ | A new session on every sign-in. |
| V7.3.1 | 2 | ❌ | No inactivity timeout: lastSeenAt is recorded but not enforced. Needs a decided idle limit per identity. |
| V7.3.2 | 2 | ✅ | Absolute session lifetime 8 hours. |
| V7.4.1 | 1 | ✅ | Logout revokes the session row; a revoked token is refused. |
| V7.4.2 | 1 | ✅ | Disabled merchants/staff are refused on every request; staff deactivation revokes sessions. |
| V7.4.3 | 2 | ✅ | Password change ends every other session; reset ends all. |
| V7.4.4 | 2 | ✅ | Logout reachable from every shell (logout:guard). |
| V7.4.5 | 2 | 🟡 | Owner can disable an account (all sessions refused); no per-session admin revocation screen. |
| V7.5.1 | 2 | ✅ | Owner email change and TOTP changes require the current password; merchants have no email-change endpoint. |
| V7.5.2 | 2 | 🟡 | Users can view and end sessions; ending them does not require re-entering a factor. |
| V7.6.1 | 2 | ➖ | No federated identity / SSO. |
| V7.6.2 | 2 | ➖ | No federated identity / SSO. |

### V8 — Authorization

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V8.1.1 | 1 | ✅ | Permission matrix (ADR-003), enforced server-side on every route (requireStoreActor / requirePlatformActor). |
| V8.1.2 | 2 | 🟡 | Field-level rules exist where found (wallet hidden from staff, fixed in this review) but are not documented as a matrix. |
| V8.2.1 | 1 | ✅ | Permission matrix (ADR-003), enforced server-side on every route (requireStoreActor / requirePlatformActor). |
| V8.2.2 | 1 | ✅ | Permission matrix (ADR-003), enforced server-side on every route (requireStoreActor / requirePlatformActor). |
| V8.2.3 | 2 | 🟡 | Field-level rules exist where found (wallet hidden from staff, fixed in this review) but are not documented as a matrix. |
| V8.3.1 | 1 | ✅ | Permission matrix (ADR-003), enforced server-side on every route (requireStoreActor / requirePlatformActor). |
| V8.4.1 | 2 | ✅ | Tenant isolation enforced by composite foreign keys in the database (phase5:test). |

### V9 — Self-contained Tokens

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V9.1.1 | 1 | ✅ | jwt.verify with algorithms ['HS256'] and keys from the environment (rotation supported). |
| V9.1.2 | 1 | ✅ | jwt.verify with algorithms ['HS256'] and keys from the environment (rotation supported). |
| V9.1.3 | 1 | ✅ | jwt.verify with algorithms ['HS256'] and keys from the environment (rotation supported). |
| V9.2.1 | 1 | ✅ | exp enforced, plus the server-side session expiry. |
| V9.2.2 | 2 | ✅ | identityKind checked on every verify (IDENTITY_BOUNDARY_DENIED). |
| V9.2.3 | 2 | ✅ | Single service, symmetric key: tokens are only accepted by the API that issued them, and typed per identity. |
| V9.2.4 | 2 | ✅ | Single service, symmetric key: tokens are only accepted by the API that issued them, and typed per identity. |

### V10 — OAuth and OIDC

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V10.1.1 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.1.2 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.2.1 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.2.2 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.3.1 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.3.2 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.3.3 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.3.4 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.1 | 1 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.2 | 1 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.3 | 1 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.4 | 1 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.5 | 1 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.6 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.7 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.8 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.9 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.10 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.4.11 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.5.1 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.5.2 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.5.3 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.5.4 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.5.5 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.6.1 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.6.2 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.7.1 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.7.2 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |
| V10.7.3 | 2 | ➖ | No OAuth/OIDC (the platform issues its own sessions). |

### V11 — Cryptography

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V11.1.1 | 2 | 🟡 | Key rotation implemented (SESSION_JWT_SECRET_PREVIOUS, CODIQ_ENCRYPTION_KEY_PREVIOUS, backup key) and described in DEPLOYMENT.md; no single key-lifecycle policy document. |
| V11.1.2 | 2 | ✅🔧 | Cryptographic inventory written in this review (section 4 of this document). |
| V11.2.1 | 2 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |
| V11.2.2 | 2 | ✅ | Versioned ciphertext envelopes (secret box, backup CODIQBK1) allow algorithm changes. |
| V11.2.3 | 2 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |
| V11.3.1 | 1 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |
| V11.3.2 | 1 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |
| V11.3.3 | 2 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |
| V11.4.1 | 1 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |
| V11.4.2 | 2 | ✅ | bcrypt cost 12 for passwords. |
| V11.4.3 | 2 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |
| V11.4.4 | 2 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |
| V11.5.1 | 2 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |
| V11.6.1 | 2 | ✅ | Node crypto: AES-256-GCM, HKDF-SHA256, HMAC-SHA256, CSPRNG; no ECB, no weak padding. |

### V12 — Secure Communication

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V12.1.1 | 1 | ✅ | TLS terminated by Cloudflare/the host with publicly trusted certificates (deployment). |
| V12.1.2 | 2 | ✅ | TLS terminated by Cloudflare/the host with publicly trusted certificates (deployment). |
| V12.1.3 | 2 | ➖ | No mTLS. |
| V12.2.1 | 1 | ✅ | TLS terminated by Cloudflare/the host with publicly trusted certificates (deployment). |
| V12.2.2 | 1 | ✅ | TLS terminated by Cloudflare/the host with publicly trusted certificates (deployment). |
| V12.3.1 | 2 | 🟡 | Outbound HTTPS to providers verified by Node; database TLS depends on the connection string (Supabase enforces TLS) — not asserted by the app. |
| V12.3.2 | 2 | 🟡 | Outbound HTTPS to providers verified by Node; database TLS depends on the connection string (Supabase enforces TLS) — not asserted by the app. |
| V12.3.3 | 2 | ✅ | Worker→container traffic stays inside Cloudflare; no internal plain-HTTP services. |
| V12.3.4 | 2 | ✅ | Worker→container traffic stays inside Cloudflare; no internal plain-HTTP services. |

### V13 — Configuration

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V13.1.1 | 2 | ✅🔧 | Communication inventory written in this review (section 4). |
| V13.2.1 | 2 | ✅ | Service credentials are per-service (DB, image bucket, backup bucket, mail) and never default. |
| V13.2.2 | 2 | ✅ | Service credentials are per-service (DB, image bucket, backup bucket, mail) and never default. |
| V13.2.3 | 2 | ✅ | Service credentials are per-service (DB, image bucket, backup bucket, mail) and never default. |
| V13.2.4 | 2 | ❌ | No egress allowlist: the container may reach any host. Cloudflare Containers support allowedHosts — set it to the database, storage, mail and Sentry hosts at deploy. |
| V13.2.5 | 2 | ❌ | No egress allowlist: the container may reach any host. Cloudflare Containers support allowedHosts — set it to the database, storage, mail and Sentry hosts at deploy. |
| V13.3.1 | 2 | ✅ | Secrets in Worker/GitHub secret stores; the backup key is held only by the backup job. |
| V13.3.2 | 2 | ✅ | Secrets in Worker/GitHub secret stores; the backup key is held only by the backup job. |
| V13.4.1 | 1 | ✅ | .git excluded from the image (.dockerignore). |
| V13.4.2 | 2 | ✅ | NODE_ENV=production; demo mode off by default; no debug endpoints. |
| V13.4.3 | 2 | ✅ | express.static serves files only; no directory listing. |
| V13.4.4 | 2 | ✅ | TRACE is refused by the Node HTTP server (verified). |
| V13.4.5 | 2 | ✅ | /api/ready returns verdicts only; /api/openapi.json is intentionally public documentation. |

### V14 — Data Protection

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V14.1.1 | 2 | ✅🔧 | Data classification written in this review (section 4); protection rules per class. |
| V14.1.2 | 2 | ✅🔧 | Data classification written in this review (section 4); protection rules per class. |
| V14.2.1 | 1 | 🟡 | Password-reset tokens travel in the emailed link's query string (single-use, 45 minutes, referrer policy limits leakage); everything else in bodies/headers. |
| V14.2.2 | 2 | ✅ | Every response to an identified request is Cache-Control: no-store (ق-230); only public catalogue reads are cacheable. |
| V14.2.3 | 2 | 🟡 | Merchant-configured marketing pixels receive order events; payloads should be reviewed to exclude personal data. |
| V14.2.4 | 2 | ✅ | Retention jobs purge expired operational data; backups encrypted. |
| V14.3.1 | 1 | ✅ | HttpOnly session cookies cleared at logout; no tokens in JS-readable storage. |
| V14.3.2 | 2 | ✅ | Every response to an identified request is Cache-Control: no-store (ق-230); only public catalogue reads are cacheable. |
| V14.3.3 | 2 | 🟡 | No credentials in browser storage; the offline till keeps unsent sales in IndexedDB by design. |

### V15 — Secure Coding and Architecture

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V15.1.1 | 1 | ✅🔧 | SECURITY.md (own vulnerabilities) + CI blocks high/critical dependency advisories. |
| V15.1.2 | 2 | ✅🔧 | CycloneDX SBOM produced by CI. |
| V15.1.3 | 2 | ✅ | Expensive operations identified and bounded (pagination caps, upload limits, rate limits, load test in docs/LOAD_TEST_2026-11.md). |
| V15.2.1 | 1 | ✅🔧 | Critical/high advisories fixed in this review; CI audit gate + Dependabot keep it so. |
| V15.2.2 | 2 | ✅ | Expensive operations identified and bounded (pagination caps, upload limits, rate limits, load test in docs/LOAD_TEST_2026-11.md). |
| V15.2.3 | 2 | ✅ | Production build contains no test or scaffold code (template:guard; dead OAuth helper removed in this review). |
| V15.3.1 | 1 | ✅ | Prisma selects and explicit payload builders return only needed fields. |
| V15.3.2 | 2 | ✅🔧 | Provider calls now refuse redirects (redirect: 'error'). |
| V15.3.3 | 2 | ✅ | zod schemas + explicit data objects; no request body spread into ORM writes. |
| V15.3.4 | 2 | ✅ | Trusted-edge client IP (client-ip.ts). |
| V15.3.5 | 2 | ✅ | TypeScript strict + ESLint eqeqeq in CI. |
| V15.3.6 | 2 | ✅ | Parsed JSON validated by zod (unknown keys dropped); Maps/Sets used for dynamic keys. |
| V15.3.7 | 2 | ✅ | zod rejects arrays where a single value is expected. |

### V16 — Security Logging and Error Handling

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V16.1.1 | 2 | 🟡 | Logging documented in logger.ts / redact.ts and guarded; no standalone log inventory document. |
| V16.2.1 | 2 | ✅ | JSON lines with ISO-8601 UTC time, request id, route, actor and store from context. |
| V16.2.2 | 2 | ✅ | JSON lines with ISO-8601 UTC time, request id, route, actor and store from context. |
| V16.2.3 | 2 | ✅ | Logs go to stdout (host log pipeline) and faults to Sentry only. |
| V16.2.4 | 2 | ✅ | JSON lines with ISO-8601 UTC time, request id, route, actor and store from context. |
| V16.2.5 | 2 | ✅ | Central redaction of secrets/tokens/personal keys (logging:guard). |
| V16.3.1 | 2 | ✅🔧 | Security refusals logged at warn with client address; every issued session logged (fixed in this review). |
| V16.3.2 | 2 | ✅🔧 | Security refusals logged at warn with client address; every issued session logged (fixed in this review). |
| V16.3.3 | 2 | ✅🔧 | Security refusals logged at warn with client address; every issued session logged (fixed in this review). |
| V16.3.4 | 2 | ✅ | Unexpected errors logged once with stack and reported to Sentry. |
| V16.4.1 | 2 | ✅ | Structured JSON serialization prevents log injection. |
| V16.4.2 | 2 | 🟡 | Faults ship to Sentry; general logs depend on the host's log retention — forward them to a separate store at deploy. |
| V16.4.3 | 2 | 🟡 | Faults ship to Sentry; general logs depend on the host's log retention — forward them to a separate store at deploy. |
| V16.5.1 | 2 | ✅ | Generic message for unmapped errors; mapped errors carry codes, never stacks. |
| V16.5.2 | 2 | ✅ | Outbox retries for mail; guards fail closed. |
| V16.5.3 | 2 | ✅ | Outbox retries for mail; guards fail closed. |

### V17 — WebRTC

| البند | م | الحالة | الدليل |
|---|---|---|---|
| V17.1.1 | 2 | ➖ | No WebRTC. |
| V17.2.1 | 2 | ➖ | No WebRTC. |
| V17.2.2 | 2 | ➖ | No WebRTC. |
| V17.2.3 | 2 | ➖ | No WebRTC. |
| V17.2.4 | 2 | ➖ | No WebRTC. |
| V17.3.1 | 2 | ➖ | No WebRTC. |
| V17.3.2 | 2 | ➖ | No WebRTC. |

---
الرموز: ✅ مستوفى · ✅🔧 أُصلح في هذه المراجعة · 🟡 جزئيّ · ❌ غير مستوفى · ➖ لا ينطبق. «م» = المستوى.
