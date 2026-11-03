-- ============================================================
-- 061_default_currency_idr
--
-- This fork is Rupiah-only. New accounts and new deals default to IDR,
-- and every existing account is moved to IDR so pipeline and dashboard
-- totals are formatted consistently.
--
-- Existing deals are NOT rewritten: `deals.currency` is the currency a
-- deal was saved in, and relabelling "USD 100" as "IDR 100" would
-- silently change its meaning. Convert them by hand if you need to:
--
--   UPDATE deals SET currency = 'IDR' WHERE currency <> 'IDR';
--
-- Idempotent — safe to run more than once.
-- ============================================================

ALTER TABLE accounts
  ALTER COLUMN default_currency SET DEFAULT 'IDR';

UPDATE accounts
  SET default_currency = 'IDR'
  WHERE default_currency <> 'IDR';

ALTER TABLE deals
  ALTER COLUMN currency SET DEFAULT 'IDR';
