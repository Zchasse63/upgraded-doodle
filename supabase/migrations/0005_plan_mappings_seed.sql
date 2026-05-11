-- 0005_plan_mappings_seed.sql
-- ============================================================================
-- Seeds plan_mappings with the three known sauna plan IDs from CC's PushPress
-- mapping to NOEQL's three plans in TSG's live Glofox.
--
-- payment_method='cash' is the Q1 resolution (verified 2026-05-11):
-- 'complimentary' is not API-accessible on NOEQL even when enabled;
-- 'direct_debit' requires a customer-side mandate that doesn't exist for
-- bridged users. 'cash' is staff_only=true, API-accessible, and combined
-- with the TESTCODE 100%-off promo produces a $0-net assignment with no
-- real charge flow. ON CONFLICT DO UPDATE keeps re-runs safe if we ever
-- need to swap the value — no code change required.
-- ============================================================================

insert into plan_mappings (
  pushpress_plan_id, pushpress_plan_name,
  glofox_membership_id, glofox_plan_code,
  payment_method, glofox_promo_code, is_active, notes
) values
  ('plan_1b27d4595fa44a', 'Sauna 8 Pack (Recurring)',
   '69fe0e2c238a9b2cd206fa15', '1778259589341',
   'cash', 'TESTCODE', true,
   'NOEQL 8-Class Membership ($1/mo, 8 sessions)'),
  ('plan_4bc45a1bda3241', 'Sauna 4 Pack (Recurring)',
   '69fe0e2c238a9b2cd206fa15', '1778259566576',
   'cash', 'TESTCODE', true,
   'NOEQL 4-Class Membership ($1/mo, 4 sessions)'),
  ('plan_2be74145dfef43', 'Sauna Unlimited (Recurring)',
   '69fe0e2c238a9b2cd206fa15', '1778257393182',
   'cash', 'TESTCODE', true,
   'NOEQL Unlimited ($1/mo)')
on conflict (pushpress_plan_id) do update set
  pushpress_plan_name  = excluded.pushpress_plan_name,
  glofox_membership_id = excluded.glofox_membership_id,
  glofox_plan_code     = excluded.glofox_plan_code,
  payment_method       = excluded.payment_method,
  glofox_promo_code    = excluded.glofox_promo_code,
  notes                = excluded.notes;
