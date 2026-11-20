-- Audit 14-ب — the staff counterpart of ق-218.
--
-- A merchant types his employee's first password in the team screen. Nothing
-- made it temporary, and the staff dashboard had no «change my password», so
-- whoever typed it kept a working key to that employee's identity — and every
-- action in the store's audit log and at the till is attributed to the
-- employee. With ق-228 one identity may serve several shops, so the first
-- merchant's password also opened the second merchant's store.
--
-- While this column is set, every staff store surface is refused with
-- PASSWORD_CHANGE_REQUIRED except the session probe (which says so) and
-- POST /auth/password, which clears it.
--
-- NULL for every existing row on purpose, exactly as ق-218 did: a migration
-- must not lock out people who are working today.
ALTER TABLE staff
  ADD COLUMN password_set_by_provisioner_at TIMESTAMPTZ(6);

COMMENT ON COLUMN staff.password_set_by_provisioner_at IS
  'Audit 14-ب: set when a merchant chose this identity''s password; cleared when the staff member sets his own. While set, staff store surfaces are refused with PASSWORD_CHANGE_REQUIRED.';
