-- 0002_filtered_status.sql
-- ============================================================================
-- Add 'filtered' to event_log.handler_status CHECK constraint.
--
-- 'filtered' represents events that passed signature + dedup but were
-- suppressed by the Q9 sauna class-type allowlist (i.e. CrossFit reservations
-- arriving via CC's unified PushPress instance that we deliberately do NOT
-- mirror to TSG's Glofox).
--
-- Distinct from 'skipped':
--   'skipped'  = no handler registered for this event name (unknown event)
--   'filtered' = handler exists, ran, and chose not to mirror this payload
--
-- Both return 200 OK to PushPress. Ops dashboards need the distinction so a
-- spike in 'filtered' (expected, healthy CF traffic) doesn't look like a
-- spike in 'skipped' (unexpected, possibly misconfigured subscription).
-- ============================================================================

alter table event_log
  drop constraint event_log_handler_status_check,
  add constraint event_log_handler_status_check
    check (handler_status in (
      'pending',
      'success',
      'failed',
      'skipped',
      'duplicate',
      'filtered'
    ));
