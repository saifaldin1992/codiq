-- ق-244 / D-64 — «customers.manage»: إنشاءُ زبونٍ يدويّ كان محروساً بصلاحيّة عرض.
--
-- `customers.view` — رمزُ **قراءة** — كان يفتح `POST …/customers/manual`، وهو
-- **كتابة**: الثغرة الوحيدة لمبدأ أقلّ الصلاحيّات في مصفوفة المرحلة ١٤ (D14-04).
-- صار للكتابة رمزُها. `store_manager` يملكه بالدور (كلَّ الرموز)، و`store_staff`
-- لا يملكه إلّا بتجاوزٍ صريح.
--
-- والقيدُ هنا يعدّد الرموز حرفيّاً، فأيُّ رمزٍ جديدٍ في الشيفرة بلا هذه الهجرة
-- يجعل منحَه لعضوٍ واحدٍ يفشل بـ500 — كما قال حارس pg2 حين أصاب ذلك أوّل مرّة،
-- وكما وسّعته pg2d لرموز السلّة وpos_foundation لـ`pos.sell`. التوسعة نفسها.
ALTER TABLE staff_membership_permission_overrides
  DROP CONSTRAINT staff_membership_permission_overrides_code;
ALTER TABLE staff_membership_permission_overrides
  ADD CONSTRAINT staff_membership_permission_overrides_code CHECK (permission_code IN (
    'catalog.products.view',
    'catalog.products.create',
    'catalog.products.update',
    'catalog.products.delete',
    'catalog.categories.manage',
    'inventory.update',
    'orders.view',
    'orders.update',
    'customers.view',
    'customers.manage',
    'team.manage',
    'settings.manage',
    'catalog.trash.view',
    'catalog.trash.restore',
    'catalog.audit.view',
    'pos.sell'
  ));
