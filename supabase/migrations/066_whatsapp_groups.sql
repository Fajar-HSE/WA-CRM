-- ============================================================
-- 066_whatsapp_groups.sql — read-only WhatsApp group messages
--
-- Group chats are deliberately NOT stored in `conversations` / `messages`:
-- those tables assume one contact = one phone number, and everything built on
-- them (the inbox, the dashboard, broadcasts, automations, flows and the AI
-- auto-reply) would start treating a group as a customer.
--
-- Groups live in their own two tables instead, so none of that can reach them.
--
--   whatsapp_groups          one row per group an admin chose to monitor.
--                            Messages of a group that is not here are dropped
--                            by the webhook, so a phone that sits in many
--                            private groups stores nothing it was not asked to.
--   whatsapp_group_messages  the messages of monitored groups, newest last.
--
-- Members of the account can read both (RLS). Nothing is written from the
-- browser: the webhook and the admin API use the service role.
--
-- Idempotent — safe to run more than once.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- WhatsApp chat id, e.g. 120363012345678901@g.us
  jid                text NOT NULL,
  subject            text,
  monitored          boolean NOT NULL DEFAULT true,
  last_message_at    timestamptz,
  last_message_text  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, jid)
);

CREATE INDEX IF NOT EXISTS whatsapp_groups_account_last_idx
  ON whatsapp_groups (account_id, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS whatsapp_group_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- WhatsApp message id; NULL ids are allowed but never de-duplicated.
  message_id    text,
  from_me       boolean NOT NULL DEFAULT false,
  -- Who wrote it. The number is NULL when WhatsApp only gave an opaque id.
  sender_phone  text,
  sender_name   text,
  content_type  text NOT NULL DEFAULT 'text',
  content_text  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_group_messages_group_message_idx
  ON whatsapp_group_messages (group_id, message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS whatsapp_group_messages_group_created_idx
  ON whatsapp_group_messages (group_id, created_at DESC);

ALTER TABLE whatsapp_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_group_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_groups_select ON whatsapp_groups;
CREATE POLICY whatsapp_groups_select ON whatsapp_groups FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_group_messages_select ON whatsapp_group_messages;
CREATE POLICY whatsapp_group_messages_select ON whatsapp_group_messages FOR SELECT
  USING (is_account_member(account_id));

-- No INSERT / UPDATE / DELETE policies: with RLS on, that means only the
-- service role (webhook, admin API) can write.
