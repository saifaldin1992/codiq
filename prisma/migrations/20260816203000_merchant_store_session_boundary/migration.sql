-- A merchant session is not global: it is explicitly bound to one of that merchant's stores.
ALTER TABLE merchant_sessions
  ADD COLUMN store_id UUID REFERENCES stores(id) ON DELETE RESTRICT;

-- A prior merchant session had no store context. Revoke it instead of assigning a store implicitly.
DELETE FROM merchant_sessions;

ALTER TABLE merchant_sessions
  ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX merchant_sessions_store_idx ON merchant_sessions(store_id);

CREATE OR REPLACE FUNCTION codiq_guard_merchant_session_store()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM stores
    WHERE id = NEW.store_id AND merchant_id = NEW.merchant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'CODIQ_STORE_SESSION_BOUNDARY: merchant session store must belong to the same merchant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER merchant_sessions_guard_store_ownership
BEFORE INSERT OR UPDATE OF merchant_id, store_id ON merchant_sessions
FOR EACH ROW EXECUTE FUNCTION codiq_guard_merchant_session_store();
