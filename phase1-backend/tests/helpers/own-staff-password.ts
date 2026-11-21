/**
 * Audit 14-ب — what a newly added store employee does before anything else.
 *
 * The merchant types the first password in the team screen, and until the
 * employee replaces it every staff store surface answers PASSWORD_CHANGE_REQUIRED.
 * That rule is proven by `review-fixes.integration.mjs`. Every OTHER suite adds
 * staff only because it needs one, so this is the one copy of «the employee takes
 * ownership of his password» they all call — the staff twin of
 * `own-provisioned-password.ts`, and through the same REAL doors: staff login,
 * then `POST /auth/password`.
 *
 * It changes the password and then changes it BACK to the text the suite already
 * knows. The mark is cleared by the first change and stays cleared, and the
 * suite's later logins with its known password keep working unchanged. Call it
 * right after creating the member and BEFORE the suite opens its own staff
 * sessions: a password change ends the identity's other sessions. Its own
 * session is signed out at the end, so session counts are untouched.
 */
export async function ownStaffPassword(
  apiRoot: string,
  storeSlug: string,
  email: string,
  password: string
): Promise<void> {
  // `apiRoot` is wherever the suite's API answers: `http://host:port` for suites
  // that mount `createApp()` directly, `http://host:port/api` for the full server.
  const api = apiRoot.replace(/\/$/, "");
  const headers = { "content-type": "application/json", origin: new URL(api).origin };
  const login = await fetch(`${api}/auth/staff/stores/${encodeURIComponent(storeSlug)}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  const session = await login.json().catch(() => null);
  if (login.status !== 200)
    throw new Error(
      `14-ب helper: staff login failed (${login.status}): ${JSON.stringify(session)}`
    );
  const interim = `${password}-Interim1`;
  for (const [currentPassword, newPassword] of [
    [password, interim],
    [interim, password],
  ]) {
    const changed = await fetch(`${api}/auth/password`, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (changed.status !== 200)
      throw new Error(
        `14-ب helper: password change failed (${changed.status}): ${JSON.stringify(await changed.json().catch(() => null))}`
      );
  }
  // Leave nothing behind: suites count this identity's sessions.
  const logout = await fetch(`${api}/auth/logout`, {
    method: "POST",
    headers: { ...headers, authorization: `Bearer ${session.accessToken}` },
  });
  if (!logout.ok) throw new Error(`14-ب helper: logout failed (${logout.status})`);
}
