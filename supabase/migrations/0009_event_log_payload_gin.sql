-- 0009_event_log_payload_gin.sql
-- ============================================================================
-- Adds a GIN index on event_log.payload so the reconcile audits (both the
-- local script and the daily Edge Function) can efficiently filter by
-- `payload->'data'->>'id'` and `payload->'data'->>'reservedId'`.
--
-- Without this index, post-cutover the audit becomes O(reservations × rows)
-- where each lookup scans event_log sequentially. After CC's full CrossFit
-- schedule is in PushPress, the 30-day window can contain hundreds of sauna
-- reservations, each triggering a sequential scan. Index pre-empts that.
--
-- We use a single GIN on the full payload (jsonb_path_ops would be faster
-- for exact-equality lookups but loses generality; we'd rather have one
-- index that works for all the JSONB filters in the codebase).
-- ============================================================================

create index if not exists event_log_payload_idx
  on event_log
  using gin (payload);

comment on index event_log_payload_idx is
  'Supports reconcile audits that filter by payload->data->>id and payload->data->>reservedId. Critical for post-cutover CC scale.';
