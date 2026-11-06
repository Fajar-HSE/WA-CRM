-- ============================================================
-- 062_invite_only_workspaces
--
-- Invite-only registration, one workspace (and one WhatsApp number) per
-- invited person.
--
--   1. account_invitations.kind: 'member' (join the inviter's account, the
--      old behaviour) or 'workspace' (the invitee gets an account of their
--      own). A workspace invitation is single-use: it is claimed the moment
--      the person registers.
--   2. accounts.can_connect_whatsapp: only accounts that arrived through a
--      workspace invitation may create a WAHA session. Existing accounts are
--      grandfathered (set to TRUE once, when the column is first added).
--   3. Triggers so none of this can be switched on from the browser:
--      users cannot flip can_connect_whatsapp, cannot create/alter the WAHA
--      columns of whatsapp_config, and cannot redeem a workspace invitation
--      through the old join-an-account path.
--
-- "From the browser" = the request carries the `authenticated` JWT role. The
-- server (service role), the SQL editor and migrations are not affected.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- Role claim of the current request: 'anon' | 'authenticated' | 'service_role',
-- or NULL outside PostgREST (SQL editor, migrations).
CREATE OR REPLACE FUNCTION public.current_jwt_role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    NULLIF(current_setting('request.jwt.claim.role', true), '')
  )
$$;

-- ------------------------------------------------------------
-- 1. Invitation kind
-- ------------------------------------------------------------
ALTER TABLE account_invitations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'member';

ALTER TABLE account_invitations
  DROP CONSTRAINT IF EXISTS account_invitations_kind_check;
ALTER TABLE account_invitations
  ADD CONSTRAINT account_invitations_kind_check
  CHECK (kind IN ('member', 'workspace'));

-- A workspace invitation creates a new account at registration. It must not
-- be redeemable by an existing user through redeem_invitation (which moves a
-- user INTO the inviter's account).
CREATE OR REPLACE FUNCTION public.guard_workspace_invitation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.kind = 'workspace'
     AND OLD.accepted_at IS NULL
     AND NEW.accepted_at IS NOT NULL
     AND public.current_jwt_role() = 'authenticated' THEN
    RAISE EXCEPTION 'This invitation creates a new account; it cannot be used to join an existing one'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_workspace_invitation ON account_invitations;
CREATE TRIGGER guard_workspace_invitation
  BEFORE UPDATE ON account_invitations
  FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_invitation();

-- peek_invitation now also reports the kind so /join/<token> can render the
-- right page. Same body as migration 019 plus 'kind'.
CREATE OR REPLACE FUNCTION public.peek_invitation(
  p_token_hash TEXT
) RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;

  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT name INTO v_account_name
  FROM accounts
  WHERE id = v_inv.account_id;

  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'kind', v_inv.kind,
    'expires_at', v_inv.expires_at
  );
END;
$$;

ALTER FUNCTION public.peek_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;

-- ------------------------------------------------------------
-- 2. Who may connect WhatsApp
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name = 'can_connect_whatsapp'
  ) THEN
    ALTER TABLE accounts
      ADD COLUMN can_connect_whatsapp BOOLEAN NOT NULL DEFAULT FALSE;
    -- Grandfather every account that exists today (runs once only).
    UPDATE accounts SET can_connect_whatsapp = TRUE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.protect_account_whatsapp_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.current_jwt_role() = 'authenticated' THEN
    IF TG_OP = 'INSERT' AND NEW.can_connect_whatsapp THEN
      RAISE EXCEPTION 'can_connect_whatsapp can only be set by the server'
        USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.can_connect_whatsapp IS DISTINCT FROM OLD.can_connect_whatsapp THEN
      RAISE EXCEPTION 'can_connect_whatsapp can only be changed by the server'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_account_whatsapp_flag ON accounts;
CREATE TRIGGER protect_account_whatsapp_flag
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.protect_account_whatsapp_flag();

-- The WAHA session a config row points at decides which WhatsApp number the
-- CRM sends from. It is set by the server after the can_connect_whatsapp check,
-- never straight from the browser.
CREATE OR REPLACE FUNCTION public.protect_whatsapp_waha_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.current_jwt_role() = 'authenticated' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.provider = 'waha'
         OR NEW.waha_session_name IS NOT NULL
         OR NEW.waha_base_url IS NOT NULL THEN
        RAISE EXCEPTION 'WAHA settings can only be changed by the server'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.waha_session_name IS DISTINCT FROM OLD.waha_session_name
       OR NEW.waha_base_url IS DISTINCT FROM OLD.waha_base_url THEN
      RAISE EXCEPTION 'WAHA settings can only be changed by the server'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_whatsapp_waha_columns ON whatsapp_config;
CREATE TRIGGER protect_whatsapp_waha_columns
  BEFORE INSERT OR UPDATE ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.protect_whatsapp_waha_columns();
