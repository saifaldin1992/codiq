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
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}
