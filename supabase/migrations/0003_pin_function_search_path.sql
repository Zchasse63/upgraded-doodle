-- 0003_pin_function_search_path.sql
-- ============================================================================
-- Pin tsg_bridge_set_updated_at's search_path.
--
-- Postgres functions without an explicit search_path inherit the caller's
-- which is a long-standing source of confused-deputy issues. Supabase's
-- security linter flags this with WARN level — fix is a one-line addition.
--
-- The function is invoked by a trigger on UPDATE; restricting to pg_catalog
-- + pg_temp ensures `now()` resolves to the built-in regardless of who is
-- doing the UPDATE.
-- ============================================================================

create or replace function tsg_bridge_set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
