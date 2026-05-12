-- 0010_groupon_codes.sql
-- ============================================================================
-- Source-of-truth tables for the Groupon rotation system.
--
-- Glofox caps each account at 100 total discount entities. TSG has two
-- parallel Groupon campaigns of 500 codes each (1000 total) but can only
-- fit 86 in Glofox at a time (43 G1 + 43 G2, leaving 14 slots for other
-- discounts + headroom). The rotation cron polls Glofox, detects which
-- codes have been redeemed (= no longer in Glofox), marks them used here,
-- and uploads the next queued code so the campaign stays at 43 active.
--
-- See docs/glofox-groupon-bulk-upload.md for the broader workflow.
-- ============================================================================

create table groupon_codes (
  code                    text         primary key,
  campaign                text         not null
    check (campaign in ('groupon_1', 'groupon_2')),
  csv_row_index           integer      not null,  -- 1-based; preserves the
                                                  -- "fill from top" upload order
  status                  text         not null default 'queued'
    check (status in ('queued', 'uploaded', 'used', 'failed')),

  -- Set when status='uploaded':
  glofox_discount_id      text,
  glofox_promo_code_id    text,
  uploaded_at             timestamptz,

  -- Set when status='used' (detected via polling, not a real-time signal —
  -- so used_detected_at reflects when we noticed it, not when the customer
  -- actually redeemed; the lag = poll interval):
  used_detected_at        timestamptz,

  -- Set when status='failed' (e.g., Glofox rejected the create):
  failure_reason          text,
  failed_at               timestamptz,

  -- Stable bookkeeping:
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table groupon_codes is
  'Master record of all Groupon codes for both campaigns. The rotation cron reads/writes this; the CSVs in scripts/groupon-{1,2}-codes.csv are the original Groupon-issued list seeded once via scripts/bootstrap-groupon-codes.ts.';

-- Indexes for the cron's hot queries:
create index groupon_codes_status_campaign_idx
  on groupon_codes (status, campaign);

create index groupon_codes_campaign_order_idx
  on groupon_codes (campaign, csv_row_index);

create index groupon_codes_glofox_promo_id_idx
  on groupon_codes (glofox_promo_code_id)
  where glofox_promo_code_id is not null;

-- Update trigger to keep updated_at current
create or replace function tsg_groupon_codes_set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger groupon_codes_updated_at
  before update on groupon_codes
  for each row execute function tsg_groupon_codes_set_updated_at();

alter table groupon_codes enable row level security;

-- ----------------------------------------------------------------------------
-- groupon_rotation_runs — one row per cron invocation, for audit + ops
-- ----------------------------------------------------------------------------

create table groupon_rotation_runs (
  id                        uuid         primary key default gen_random_uuid(),
  started_at                timestamptz  not null default now(),
  completed_at              timestamptz,
  status                    text         not null default 'running'
    check (status in ('running', 'success', 'jwt_expired', 'error', 'no_op')),

  -- Counters:
  detected_used             integer      not null default 0,
  attempted_uploads         integer      not null default 0,
  successful_uploads        integer      not null default 0,
  failed_uploads            integer      not null default 0,

  -- Diagnostics:
  jwt_expires_at            timestamptz,
  error_message             text,
  per_campaign_state        jsonb,        -- {"groupon_1": {"uploaded": 43, "queued": 446, ...}, ...}

  created_at                timestamptz  not null default now()
);

create index groupon_rotation_runs_started_at_idx
  on groupon_rotation_runs (started_at desc);

comment on table groupon_rotation_runs is
  'Audit log: one row per groupon-rotate-cron run. Tracks JWT expiry, codes detected used, uploads attempted/succeeded/failed.';

alter table groupon_rotation_runs enable row level security;
