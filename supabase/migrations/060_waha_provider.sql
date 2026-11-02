-- Migration: add WhatsApp provider support (Meta default + WAHA)
-- Phase 2 of WAHA integration.

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS waha_session_name TEXT,
  ADD COLUMN IF NOT EXISTS waha_base_url TEXT,
  ADD COLUMN IF NOT EXISTS waha_session_status TEXT;

-- Unique session name per WAHA instance (best-effort; NULLs allowed).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_waha_session_name_unique
  ON public.whatsapp_config (waha_session_name)
  WHERE waha_session_name IS NOT NULL;

-- Backfill existing rows.
UPDATE public.whatsapp_config
  SET provider = 'meta'
  WHERE provider IS NULL;
