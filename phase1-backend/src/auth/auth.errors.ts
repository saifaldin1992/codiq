export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /**
     * PG-2: optional extra keys merged INTO the `error` object of the response
     * — the restore conflict payload (`conflicts`, `hint`) is the first user.
     * Absent by default, so every pre-existing error body is byte-identical.
     */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * The ONE answer for «this email is already somebody's» across every identity
 * (owner, platform staff, merchant, store staff). It must not vary by WHICH
 * identity holds the address: the public merchant door would otherwise tell a
 * stranger which address belongs to the platform owner.
 */
export const EMAIL_TAKEN_ON_PLATFORM = "هذا البريد مستخدم لحساب آخر على المنصّة ولا يمكن استعماله هنا. استعمل بريداً آخر.";
