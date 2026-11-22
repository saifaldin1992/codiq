/**
 * The Arabic text for each API error code — the one table, read by the storefront's
 * `errorMessage` and by the market's fetch helpers (review batch 2, م-١). The API's contract
 * is the code; the server's own message is a fallback, and some of it is English.
 */
import type { ApiErrorCode } from "./storefront-api";

export const ERROR_TEXT: Partial<Record<ApiErrorCode, string>> = {
  CUSTOMER_SESSION_REQUIRED: "سجّل الدخول للمتابعة إلى هذه الصفحة.",
  INVALID_CUSTOMER_CREDENTIALS: "بيانات الدخول غير صحيحة.",
  INVALID_CART_QUANTITY: "الكمية المطلوبة غير صالحة.",
  CART_EMPTY: "لا يمكن إتمام طلب من سلة فارغة.",
  INVALID_ADDRESS: "تحقق من بيانات العنوان ثم حاول مجددًا.",
  PAYMENT_METHOD_NOT_SUPPORTED: "طريقة الدفع المتاحة حاليًا هي الدفع عند الاستلام فقط.",
  IDEMPOTENCY_KEY_REUSED:
    "تعذر إكمال المحاولة الحالية. تم تحديث البيانات، راجع السلة ثم حاول مجددًا.",
  CART_VERSION_CONFLICT: "تم تحديث السلة. أعدنا تحميل أحدث بياناتها.",
  CART_ALREADY_CHECKED_OUT: "تم تحويل هذه السلة إلى طلب سابقًا.",
  CART_PRICE_CHANGED: "تغيّرت أسعار بعض منتجات سلتك. حدّثنا الأسعار — راجع الملخص ثم أكّد الطلب.",
  PRODUCT_UNAVAILABLE: "أحد المنتجات لم يعد متاحًا. عدّل السلة ثم حاول مجددًا.",
  INSUFFICIENT_AVAILABLE_STOCK: "الكمية المطلوبة لم تعد متاحة بالكامل.",
  DELIVERY_UNAVAILABLE_FOR_GOVERNORATE:
    "التوصيل غير متاح حاليًا للمحافظة المختارة. اختر عنوانًا في محافظة متاحة.",
  RATE_LIMITED: "كثرت المحاولات. انتظر قليلًا ثم حاول مجددًا.",
  RESOURCE_NOT_FOUND: "العنصر المطلوب غير موجود أو غير متاح.",
  INVALID_COUPON_CODE: "صيغة رمز الكوبون غير صالحة.",
  COUPON_INVALID: "الكوبون غير صالح لهذا المتجر أو تم إيقافه.",
  COUPON_EXPIRED: "الكوبون خارج فترة صلاحيته.",
  COUPON_MIN_SUBTOTAL_NOT_MET: "قيمة السلة أقل من الحد الأدنى المطلوب لهذا الكوبون.",
  COUPON_EXHAUSTED: "انتهت مرات استخدام هذا الكوبون.",
  COUPON_CUSTOMER_LIMIT_REACHED: "استخدمت هذا الكوبون بالحد الأقصى المسموح لحسابك.",
  PRESCRIPTION_NOT_REQUIRED: "هذا الطلب لا يتطلب وصفة طبية.",
  PRESCRIPTION_ALREADY_SUBMITTED: "الوصفة مرفوعة بالفعل وهي قيد المراجعة أو معتمدة.",
  INVALID_PRESCRIPTION_IMAGE:
    "ملف الوصفة يجب أن يكون صورة JPEG أو PNG أو WebP بحجم لا يتجاوز 5 MB.",
  PRESCRIPTION_NOT_APPROVED: "لا يمكن معالجة الطلب قبل اعتماد الوصفة الطبية.",
  INVALID_TRACKING_REQUEST: "أدخل رقم الطلب ورقم الهاتف المستخدم عند الطلب.",
  ORDER_NOT_CANCELLABLE:
    "بدأ المتجر بتجهيز طلبك، فلم يعد إلغاؤه ممكنًا من هنا — تواصل مع المتجر مباشرة.",
  INVALID_CANCELLATION_REASON: "سبب الإلغاء طويل جدًا — اختصره في 500 حرف.",
  STORE_ON_VACATION:
    "المتجر في إجازة مؤقتة ولا يستقبل طلبات جديدة حالياً — يمكنك التصفّح وإتمام الطلب بعد عودته.",
  STORE_IN_MAINTENANCE: "المتجر مغلق للصيانة — نعود قريباً.",
  CAPABILITY_UNAVAILABLE: "هذه الخدمة غير متاحة حالياً.",
  GUEST_CHECKOUT_DISABLED: "هذا المتجر يطلب تسجيل الدخول لإتمام الطلب.",
  STORE_NOT_ACCEPTING_ORDERS: "المتجر لا يستقبل طلبات جديدة حالياً — تواصل مع المتجر.",
  CUSTOMER_ACCOUNT_EXISTS: "هذا الرقم مسجّل لدينا — سجّل الدخول لإتمام الطلب.",
  EMAIL_TAKEN: "هذا البريد مستخدم لحساب آخر في هذا المتجر — اتركه فارغاً أو سجّل الدخول.",
  INVALID_FULL_NAME: "اكتب اسمك الكامل.",
  INVALID_PHONE: "اكتب رقم هاتفك بصيغة 07XXXXXXXXX.",
  ACCOUNT_HAS_PASSWORD: "هذا الحساب يملك كلمة مرور بالفعل.",
};
