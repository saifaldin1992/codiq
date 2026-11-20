# نطاق المرحلة الأولى

ينفّذ هذا المشروع في المرحلة الأولى طبقة خادم مستقلة في `phase1-backend/` مبنية على Node.js وTypeScript وPostgreSQL وPrisma. لم تُعدّل واجهة القالب ولم تُنشأ صفحات؛ ذلك خارج نطاق المرحلة الحالية.

## عقود الهوية

| نوع الهوية | جدول الحساب | نقطة الدخول | الوجهة الثابتة بعد النجاح |
|---|---|---|---|
| مالك المنصة | `platform_owners` | `POST /auth/platform/login` | `/platform/dashboard` |
| تاجر | `merchants` | `POST /auth/merchant/login` | `/merchant/dashboard` |
| زبون متجر | `customers` | `POST /stores/:storeSlug/account/login` | `/stores/:storeSlug/account` |

لا تبحث أي نقطة دخول في أكثر من جدول هوية واحد. لا توجد نقطة دخول عامة تحاول استنتاج الدور من البريد الإلكتروني، ولا توجد وجهة احتياطية مختلطة.

## قاعدة العزل

يعالج PostgreSQL منع البريد المتداخل بين `platform_owners` و`merchants` عبر Triggers مع قفل معاملاتي على البريد المطبّع، ولذلك لا يمكن تجاوز المنع عبر واجهة أو API أو اتصال مباشر بقاعدة البيانات.

