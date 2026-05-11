-- 0005_plan_mappings_seed.sql
-- ============================================================================
-- Seeds plan_mappings with the three known sauna plan IDs from CC's PushPress
-- mapping to NOEQL's three plans in TSG's live Glofox.
--
-- payment_method='complimentary' is the current Q1 candidate (see
-- docs/open-questions.md). It will be confirmed (or replaced) on first live
-- replay against Glofox. ON CONFLICT DO UPDATE makes this safe to re-run if
-- we need to swap the payment_method value later — no code change required.
-- ============================================================================

insert into plan_mappings (
  pushpress_plan_id, pushpress_plan_name,
  glofox_membership_id, glofox_plan_code,
  payment_method, glofox_promo_code, is_active, notes
) values
  ('plan_1b27d4595fa44a', 'Sauna 8 Pack (Recurring)',
   '69fe0e2c238a9b2cd206fa15', '1778259589341',
   'complimentary', 'TESTCODE', true,
   'NOEQL 8-Class Membership ($1/mo, 8 sessions)'),
  ('plan_4bc45a1bda3241', 'Sauna 4 Pack (Recurring)',
   '69fe0e2c238a9b2cd206fa15', '1778259566576',
   'complimentary', 'TESTCODE', true,
   'NOEQL 4-Class Membership ($1/mo, 4 sessions)'),
  ('plan_2be74145dfef43', 'Sauna Unlimited (Recurring)',
   '69fe0e2c238a9b2cd206fa15', '1778257393182',
   'complimentary', 'TESTCODE', true,
   'NOEQL Unlimited ($1/mo)')
on conflict (pushpress_plan_id) do update set
  pushpress_plan_name  = excluded.pushpress_plan_name,
  glofox_membership_id = excluded.glofox_membership_id,
  glofox_plan_code     = excluded.glofox_plan_code,
  payment_method       = excluded.payment_method,
  glofox_promo_code    = excluded.glofox_promo_code,
  notes                = excluded.notes;
