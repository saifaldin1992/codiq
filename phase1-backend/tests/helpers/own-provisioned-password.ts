/**
 * ق-218 / ق-226 — what a hand-provisioned merchant does before anything else.
 *
 * `createManualMerchant` lets a platform actor type the account's first password,
 * and until the merchant replaces it EVERY merchant surface is refused
 * (`PASSWORD_CHANGE_REQUIRED`) and the shell sends him to «الأمان» rather than his
 * dashboard. Both rules are proven end to end by `phase6:test` and through a real
 * browser by `phase6:browser`; that is where they belong.
 *
 * Every OTHER suite provisions a merchant only because it needs one — phase 7
 * needs a catalogue, phase 14 needs a team, the till suites need a store to sell
 * from. Re-proving the gate in each of them would be noise, and hand-rolling the
 * two calls in each of them is how eight copies drift. This is the one copy: it
 * does exactly what the merchant does on his first login, and returns the password
 * he now owns.
 *
 * Deliberately goes through the REAL doors (`/auth/merchant/login` then
 * `POST /auth/password`) rather than writing `passwordSetByProvisionerAt = NULL`
 * directly: a helper that reaches around the rule would keep passing on the day
 * the rule breaks.
 */
export async function ownProvisionedPassword(
  base: string,
  identifier: string,
  temporaryPassword: string,
  suffix = "-Owned1",
): Promise<string> {
  const newPassword = `${temporaryPassword}${suffix}`;
  const login = await fetch(`${base}/api/auth/merchant/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ identifier, password: temporaryPassword }),
  });
  const session = await login.json().catch(() => null);
  if (login.status !== 200) {
    throw new Error(`ق-218 helper: merchant login failed (${login.status}): ${JSON.stringify(session)}`);
  }
  const changed = await fetch(`${base}/api/auth/password`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ currentPassword: temporaryPassword, newPassword }),
  });
  if (changed.status !== 200) {
    throw new Error(`ق-218 helper: password change failed (${changed.status}): ${JSON.stringify(await changed.json().catch(() => null))}`);
  }
  return newPassword;
}
