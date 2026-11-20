# Security Policy · سياسة الأمان

## الإبلاغ عن ثغرة · Reporting a vulnerability

**لا تفتح Issue عامّاً لثغرة أمنيّة.** استعمل الإبلاغ الخاصّ في GitHub:
تبويب **Security** في المستودع ← **Report a vulnerability**.

**Do not open a public issue.** Use GitHub's private vulnerability reporting:
the repository's **Security** tab → **Report a vulnerability**.

اذكر · Please include:
- ما الذي يُمكِن فعله، ومن أيّ هويّة (زائر، زبون، موظّف، تاجر، طاقم المنصّة) · what an attacker can do, and as which identity
- خطوات إعادة الإنتاج أو طلب HTTP · reproduction steps or the HTTP request
- الإصدار أو الـcommit · the version or commit

## ما نلتزم به · What we commit to

| | |
|---|---|
| تأكيد الاستلام · acknowledgement | خلال ٣ أيّام عمل · within 3 business days |
| تقييمٌ أوّليّ · initial assessment | خلال ٧ أيّام · within 7 days |
| إصلاح حرج أو عالٍ · critical/high fix | نستهدف ٣٠ يوماً · target 30 days |

نذكر المُبلِّغ في ملاحظات الإصدار إن رغب. · We credit reporters in release notes if they wish.

## النطاق · Scope

داخل النطاق: الشيفرة في هذا المستودع، وأيّ نشرٍ رسميّ لها.
خارج النطاق: هجمات حجب الخدمة بالحجم، والهندسة الاجتماعيّة، وثغرات مزوّدي الاستضافة أنفسهم.

In scope: the code in this repository and its official deployments.
Out of scope: volumetric denial of service, social engineering, and vulnerabilities in the hosting providers themselves.

## الإصدارات المدعومة · Supported versions

الفرع `release` وآخر نشرٍ منه فقط. · Only the `release` branch and its latest deployment.

## الضوابط القائمة · Controls in place

عزل المستأجرين في قاعدة البيانات، والتحقّق من كلّ مُدخَل، وحماية CSRF، وتشفير الأسرار المخزّنة، والمصادقة الثنائيّة للمالك،
وحدود المعدّل، وفحص الاعتماديّات وCodeQL في CI. التقرير مقابل OWASP ASVS: [`docs/ASVS_L2_REVIEW.md`](docs/ASVS_L2_REVIEW.md).
