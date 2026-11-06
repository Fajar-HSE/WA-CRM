-- ============================================================
-- 064_account_disable
--
-- Lets the platform administrator switch an account off.
--
-- accounts.disabled_at: NULL = active; a timestamp = disabled since then.
-- A disabled account's people cannot use the app (the dashboard shows a
-- notice, API routes and API keys are refused), inbound WhatsApp messages
-- are dropped, and its WAHA session is stopped. Nothing is deleted:
-- enabling the account again brings it back as it was.
--
-- A browser session (JWT role `authenticated`) cannot change the column, or
-- a disabled owner could simply switch themselves back on through the
-- accounts_update policy. The server (service role), the SQL editor and
-- migrations can.
--
-- To disable or enable from the SQL editor:
--
--   UPDATE accounts SET disabled_at = now()  WHERE id = '<account id>';
--   UPDATE accounts SET disabled_at = NULL   WHERE id = '<account id>';
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- current_jwt_role() comes from migration 062.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.protect_account_disabled()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.current_jwt_role() = 'authenticated' THEN
    IF TG_OP = 'INSERT' AND NEW.disabled_at IS NOT NULL THEN
      RAISE EXCEPTION 'disabled_at can only be set by the server'
        USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
      RAISE EXCEPTION 'disabled_at can only be changed by the server'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_account_disabled ON accounts;
CREATE TRIGGER protect_account_disabled
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.protect_account_disabled();
