-- 0007_pending_refunds_class_cancel.sql
-- ============================================================================
-- Adds 'class_cancel_glofox_failed' to pending_refunds.failure_reason check
-- constraint. Used by the class.canceled fan-out handler when one or more
-- per-booking DELETEs against Glofox fail.
-- ============================================================================

alter table pending_refunds
  drop constraint pending_refunds_failure_reason_check,
  add  constraint pending_refunds_failure_reason_check
    check (failure_reason in (
      'capacity_full',
      'slot_unmappable',
      'member_unlinkable',
      'glofox_5xx',
      'class_cancel_glofox_failed',
      'other'
    ));
