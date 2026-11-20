/**
 * ق-183 — how a test creates a merchant now that `POST /auth/merchant/register`
 * is gone.
 *
 * That route was a second door into one act. The public path
 * (`/public/merchants/register`) reads the platform's self-registration policy
 * and writes `approvalStatus`; this one did neither, so a script that found
 * it created an APPROVED merchant behind the owner's queue. Forty-two suites
 * used it as a fixture. The owner chose deletion over documentation, and the
 * suites now go through the same service the public path uses — in process,
 * with the same validation and the same error mapping — and receive the same
 * `{ status, payload }` the route used to answer, so not one assertion
 * downstream had to change.
 *
 * `body` and `response` are aliases for the three browser suites whose fetch
 * helpers named the parsed body differently. They are the same object.
 *
 * The imports stay inside the function on purpose: every suite sets its
 * environment first and only then loads the application, and this helper is
 * imported at the top of the file, before that happens.
 */
export interface DirectRegistration {
  status: number;
  // The same untyped JSON the route used to answer; suites read
  // `payload.account.id` on 201 and `payload.error.code` otherwise.
  payload: any;
  body: any;
  response: { status: number; ok: boolean };
}

export async function registerMerchantDirect(body: unknown): Promise<DirectRegistration> {
  const { registerMerchant } = await import("../../src/auth/auth.service.js");
  const { registerMerchantSchema } = await import("../../src/http/schemas/auth.schema.js");
  const { parseOrThrow } = await import("../../src/http/validate.js");
  const { classifyError } = await import("../../src/http/errors.js");
  let status: number;
  let payload: any;
  try {
    const parsed = parseOrThrow(registerMerchantSchema, body ?? {});
    const account = await registerMerchant({ email: parsed.email, password: parsed.password, businessName: parsed.businessName, ownerName: parsed.ownerName, phone: parsed.phone });
    status = 201;
    payload = { account };
  } catch (error) {
    // The same mapping the HTTP layer applies: HttpError as-is, a unique
    // violation from the database as the 409 the race tests expect.
    const outcome = classifyError(error, { path: "/auth/merchant/register", method: "POST", headers: {}, header: () => undefined } as any);
    status = outcome.status;
    payload = { error: outcome.error };
  }
  return { status, payload, body: payload, response: { status, ok: status < 400 } };
}
