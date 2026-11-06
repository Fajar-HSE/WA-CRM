-- ============================================================
-- 063_only_platform_creates_workspaces
--
-- Who may hand out new accounts.
--
-- Migration 062 let ANY account owner create a "workspace" invitation (a
-- brand-new account with its own WhatsApp number). Every invited person
-- is the owner of their own account, so invitations could chain: A invites
-- B, B invites C, each one adding a WAHA session to your server.
--
-- accounts.can_create_workspaces closes that. Only an account with the flag
-- may create a 'workspace' invitation. Everyone else can still invite
-- teammates INTO their own account ('member' invitations).
--
-- Backfill (runs once, when the column is first added): the flag goes to
-- accounts that did NOT arrive through a workspace invitation, i.e. the
-- accounts that existed before invitations. Accounts created from a
-- workspace invitation start without it. To change that for a specific
-- account, run in the SQL editor:
--
--   UPDATE accounts SET can_create_workspaces = TRUE WHERE id = '<account id>';
--
-- As with can_connect_whatsapp, a browser session cannot change the flag
-- (the `authenticated` JWT role is refused); the server, the SQL editor and
-- migrations can.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- current_jwt_role() comes from migration 062.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name = 'can_create_workspaces'
  ) THEN
    ALTER TABLE accounts
      ADD COLUMN can_create_workspaces BOOLEAN NOT NULL DEFAULT FALSE;

    UPDATE accounts a
       SET can_create_workspaces = TRUE
     WHERE NOT EXISTS (
       SELECT 1
         FROM account_invitations i
         JOIN profiles p ON p.user_id = i.accepted_by_user_id
        WHERE i.kind = 'workspace'
          AND i.accepted_by_user_id IS NOT NULL
          AND p.account_id = a.id
     );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.protect_account_workspace_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.current_jwt_role() = 'authenticated' THEN
    IF TG_OP = 'INSERT' AND NEW.can_create_workspaces THEN
      RAISE EXCEPTION 'can_create_workspaces can only be set by the server'
        USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.can_create_workspaces IS DISTINCT FROM OLD.can_create_workspaces THEN
      RAISE EXCEPTION 'can_create_workspaces can only be changed by the server'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_account_workspace_flag ON accounts;
CREATE TRIGGER protect_account_workspace_flag
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.protect_account_workspace_flag();
