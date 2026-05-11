-- 0008_event_log_retention.sql
-- ============================================================================
-- OPT-IN payload retention via pg_cron (Q11).
--
-- Nulls event_log.payload for rows older than RETENTION_DAYS (default 90)
-- while preserving all audit metadata (dedup_key, status, received_at, etc.).
--
-- SAFE IN ENVIRONMENTS WITHOUT pg_cron: the DO block checks for the extension
-- before registering the cron job. Without pg_cron, this migration is a no-op
-- and just emits a NOTICE.
--
-- To activate later: enable pg_cron in Supabase dashboard → Database →
-- Extensions, then either re-run this migration or call:
--   SELECT cron.schedule('tsg_bridge_prune_event_log_payloads', '0 3 * * *',
--                        'select tsg_bridge_prune_event_log_payloads(90)');
--
-- To run once manually (any environment):
--   SELECT tsg_bridge_prune_event_log_payloads(90);
-- ============================================================================

create or replace function tsg_bridge_prune_event_log_payloads(retention_days int default 90)
returns bigint
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  pruned bigint;
begin
  update public.event_log
  set    payload = null
  where  payload is not null
    and  received_at < now() - (retention_days || ' days')::interval;
  get diagnostics pruned = row_count;
  return pruned;
end;
$$;

comment on function tsg_bridge_prune_event_log_payloads(int) is
  'Nulls event_log.payload for rows older than retention_days (default 90). Audit metadata preserved.';

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'tsg_bridge_prune_event_log_payloads',
      '0 3 * * *',
      $cron$select tsg_bridge_prune_event_log_payloads(90)$cron$
    );
    raise notice 'pg_cron job "tsg_bridge_prune_event_log_payloads" registered (daily 3 AM UTC).';
  else
    raise notice 'pg_cron extension not enabled — skipping cron schedule. Run tsg_bridge_prune_event_log_payloads() manually or enable pg_cron.';
  end if;
end;
$$;
