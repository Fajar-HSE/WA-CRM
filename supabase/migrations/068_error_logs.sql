-- ============================================================
-- 068_error_logs.sql — a notebook for problems
--
-- Until now an error was only written to the hosting provider's
-- short-lived console log. This table keeps them where the admin can
-- read them: Settings → Error log.
--
-- One row per distinct problem (same `fingerprint`, not yet resolved).
-- When the same problem happens again the row's `occurrences` goes up
-- and `last_seen_at` moves, so a loop cannot flood the table.
--
-- Written only by the server (service role) through record_error_log().
-- Admins can read their account's rows, mark them resolved, and delete
-- them. Rows with account_id NULL (errors where no account is known)
-- are not readable through RLS; the platform administrator sees them
-- through the API.
--
-- The app strips keys, tokens, phone numbers and message text before it
-- calls record_error_log(). Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS error_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid REFERENCES accounts(id) ON DELETE CASCADE,
  -- Where it happened, e.g. 'waha.webhook', 'ai.reindex', 'ui', 'server'.
  source        text NOT NULL,
  level         text NOT NULL DEFAULT 'error' CHECK (level IN ('error', 'warning')),
  message       text NOT NULL,
  stack         text,
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint   text NOT NULL,
  occurrences   integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_error_logs_account_last_seen
  ON error_logs(account_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_fingerprint
  ON error_logs(fingerprint) WHERE resolved_at IS NULL;

ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS error_logs_select ON error_logs;
CREATE POLICY error_logs_select ON error_logs FOR SELECT
  USING (account_id IS NOT NULL AND is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS error_logs_update ON error_logs;
CREATE POLICY error_logs_update ON error_logs FOR UPDATE
  USING (account_id IS NOT NULL AND is_account_member(account_id, 'admin'))
  WITH CHECK (account_id IS NOT NULL AND is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS error_logs_delete ON error_logs;
CREATE POLICY error_logs_delete ON error_logs FOR DELETE
  USING (account_id IS NOT NULL AND is_account_member(account_id, 'admin'));

-- A signed-in admin may only flip the "resolved" fields; the content of
-- a log row is never edited from the browser.
REVOKE UPDATE ON error_logs FROM authenticated;
GRANT UPDATE (resolved_at, resolved_by) ON error_logs TO authenticated;

-- ------------------------------------------------------------
-- record_error_log(): insert, or bump the counter of an unresolved row
-- with the same fingerprint. Service role only.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_error_log(
  p_account_id  uuid,
  p_source      text,
  p_level       text,
  p_message     text,
  p_stack       text,
  p_context     jsonb,
  p_fingerprint text
)
RETURNS void AS $$
DECLARE
  v_level text := CASE WHEN p_level = 'warning' THEN 'warning' ELSE 'error' END;
BEGIN
  UPDATE error_logs
     SET occurrences  = occurrences + 1,
         last_seen_at = now(),
         message      = left(p_message, 2000),
         stack        = left(p_stack, 8000),
         context      = coalesce(p_context, '{}'::jsonb)
   WHERE fingerprint = p_fingerprint
     AND account_id IS NOT DISTINCT FROM p_account_id
     AND resolved_at IS NULL;

  IF NOT FOUND THEN
    INSERT INTO error_logs (account_id, source, level, message, stack, context, fingerprint)
    VALUES (
      p_account_id,
      left(p_source, 100),
      v_level,
      left(p_message, 2000),
      left(p_stack, 8000),
      coalesce(p_context, '{}'::jsonb),
      p_fingerprint
    );
  END IF;

  -- Housekeeping: now and then drop rows not seen for 60 days.
  IF random() < 0.01 THEN
    DELETE FROM error_logs WHERE last_seen_at < now() - interval '60 days';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.record_error_log(uuid, text, text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_error_log(uuid, text, text, text, text, jsonb, text) TO service_role;
