-- 0004_plan_mappings_promo.sql
-- ============================================================================
-- Adds glofox_promo_code to plan_mappings.
--
-- Glofox forbids creating recurring memberships at $0.00 (minimum $1.00).
-- TSG's workaround for CC-tier sauna access: $1/month NOEQL memberships +
-- a 100%-off promo code (TESTCODE) applied at purchase time, netting $0.
--
-- NULL = omit promo_code from the Glofox purchase request body entirely.
-- ============================================================================

alter table plan_mappings
  add column glofox_promo_code text;

comment on column plan_mappings.glofox_promo_code is
  'Optional promo code applied to the Glofox purchase to net $0 (Glofox forbids $0 recurring memberships). NULL = omit promo_code from request body.';
