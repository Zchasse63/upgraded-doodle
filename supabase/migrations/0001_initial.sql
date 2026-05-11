-- 0001_initial.sql
-- ============================================================================
-- tsg-cc-bridge — initial schema
-- ============================================================================
-- Five tables backing the PushPress → Glofox webhook mirror:
--   1. plan_mappings     — PushPress plan IDs → Glofox membership IDs
--   2. slot_mappings     — PushPress class/event IDs → Glofox event IDs (lazy cache)
--   3. members_link      — PushPress customer IDs → Glofox user IDs
--   4. event_log         — idempotency + audit trail for every inbound webhook
--   5. pending_refunds   — queue of bookings rejected by Glofox (capacity, etc.)
--                          awaiting manual refund in PushPress
--
-- This DB is single-purpose: the only client is the Edge Function, which uses
-- the service-role key. RLS is enabled on every table with no policies, so
-- anon/authenticated requests are denied by default (defense-in-depth).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ----------------------------------------------------------------------------
-- plan_mappings
-- ----------------------------------------------------------------------------
-- One row per PushPress plan we know how to mirror into Glofox. The
-- payment_method field is the key value the middleware passes to Glofox's
-- membership-purchase endpoint so Glofox does NOT attempt to charge the
-- customer (CC handles billing in PushPress). The exact value is an open
-- question — see docs/open-questions.md Q1.
--
-- Operator-managed (manually populated). The middleware reads, never writes.

create table plan_mappings (
  pushpress_plan_id        text         primary key,
  pushpress_plan_name      text         not null,
  glofox_membership_id     text         not null,
  glofox_plan_code         text         not null,
  payment_method           text         not null,
  is_active                boolean      not null default true,
  notes                    text,
  created_at               timestamptz  not null default now(),
  updated_at               timestamptz  not null default now()
);

comment on table plan_mappings is
  'PushPress plan → Glofox membership mapping. Operator-managed.';
comment on column plan_mappings.payment_method is
  'Value sent to Glofox MembershipPurchaseRequest.payment_method so the assign is externally-billed. Likely "complimentary" or "external"; confirm per docs/open-questions.md Q1.';

-- ----------------------------------------------------------------------------
-- slot_mappings
-- ----------------------------------------------------------------------------
-- Lazy cache of PushPress calendar item → Glofox event lookup. Populated on
-- first reservation arrival for a given slot. We do NOT pre-sync schedules
-- (CLAUDE.md / architecture.md § 6b). Old rows are safe to keep — Glofox
-- event IDs don't recycle and a stale mapping just means we'd re-verify
-- against the live event before booking.

create table slot_mappings (
  pushpress_calendar_item_id  text         primary key,
  glofox_event_id             text         not null,
  start_ts                    bigint       not null, -- Unix seconds
  end_ts                      bigint       not null,
  class_type                  text,
  last_verified_at            timestamptz  not null default now(),
  created_at                  timestamptz  not null default now()
);

create index slot_mappings_start_ts_idx on slot_mappings (start_ts);
create index slot_mappings_glofox_event_idx on slot_mappings (glofox_event_id);

comment on table slot_mappings is
  'Lazy cache: PushPress calendar_item_id → Glofox event_id, resolved on first reservation.';

-- ----------------------------------------------------------------------------
-- members_link
-- ----------------------------------------------------------------------------
-- PushPress customer_id → Glofox user_id mapping. Populated when we first
-- see a customer through enrollment.created or reservation.created. Linking
-- strategy: by email match (PushPress and Glofox both have email as a stable
-- identifier); fallback is auto-create a Glofox lead. `linked_via` records
-- which strategy was used so we can audit/reconcile later.

create table members_link (
  pushpress_customer_id  text         primary key,
  glofox_user_id         text         not null,
  email                  text         not null,
  linked_at              timestamptz  not null default now(),
  linked_via             text         not null
    check (linked_via in ('email_match', 'manual', 'auto_create_lead'))
);

create index members_link_email_idx on members_link (lower(email));
create index members_link_glofox_user_idx on members_link (glofox_user_id);

comment on table members_link is
  'PushPress customer_id → Glofox user_id link. Built up lazily by webhook handlers.';

-- ----------------------------------------------------------------------------
-- event_log
-- ----------------------------------------------------------------------------
-- Append-only audit trail of every inbound webhook. Doubles as the
-- idempotency table: `dedup_key` is a hash of (event, data.id, data.companyId,
-- created) and is unique — duplicate deliveries collide on insert and the
-- handler short-circuits without re-running.
--
-- `signature_verified` is recorded even on rejection so we can detect
-- credential issues or replay attacks.

create table event_log (
  id                     uuid         primary key default gen_random_uuid(),
  dedup_key              text         not null unique,
  pushpress_event        text         not null,
  pushpress_company_id   text,
  received_at            timestamptz  not null default now(),
  signature_verified     boolean      not null,
  handler_status         text         not null
    check (handler_status in ('pending', 'success', 'failed', 'skipped', 'duplicate')),
  handler_error          text,
  duration_ms            integer,
  payload                jsonb        not null,
  glofox_response        jsonb
);

create index event_log_event_received_idx on event_log (pushpress_event, received_at desc);
create index event_log_status_idx on event_log (handler_status)
  where handler_status in ('pending', 'failed');
create index event_log_received_idx on event_log (received_at desc);

comment on table event_log is
  'Append-only audit + idempotency. dedup_key is SHA-256 of {event, data.id, data.companyId, created}.';
comment on column event_log.dedup_key is
  'Stable hash for deduplication across PushPress webhook retries.';

-- ----------------------------------------------------------------------------
-- pending_refunds
-- ----------------------------------------------------------------------------
-- Queue of PushPress reservations that we could NOT mirror into Glofox
-- (capacity full, slot unmappable, etc.) and that require a manual refund
-- in PushPress because PushPress doesn't expose a refund API. CC staff
-- resolves these via the PushPress dashboard within ~1 business hour SLA.

create table pending_refunds (
  id                          uuid         primary key default gen_random_uuid(),
  pushpress_reservation_id    text         not null unique,
  pushpress_customer_id       text         not null,
  pushpress_calendar_item_id  text         not null,
  failure_reason              text         not null
    check (failure_reason in (
      'capacity_full',
      'slot_unmappable',
      'member_unlinkable',
      'glofox_5xx',
      'other'
    )),
  glofox_error                text,
  status                      text         not null default 'pending'
    check (status in ('pending', 'refunded', 'waived')),
  detected_at                 timestamptz  not null default now(),
  resolved_at                 timestamptz,
  resolved_by                 text,
  notes                       text
);

create index pending_refunds_pending_idx on pending_refunds (detected_at desc)
  where status = 'pending';
create index pending_refunds_customer_idx on pending_refunds (pushpress_customer_id);

comment on table pending_refunds is
  'Bookings that failed to mirror into Glofox and need manual refund in PushPress.';

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------

create or replace function tsg_bridge_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger plan_mappings_set_updated_at
  before update on plan_mappings
  for each row execute function tsg_bridge_set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS — enable on every table, no policies (deny by default).
-- The Edge Function uses the service-role key, which bypasses RLS.
-- ----------------------------------------------------------------------------

alter table plan_mappings    enable row level security;
alter table slot_mappings    enable row level security;
alter table members_link     enable row level security;
alter table event_log        enable row level security;
alter table pending_refunds  enable row level security;

-- No policies — anon/authenticated requests get zero rows. Service-role
-- bypasses. If we add an operator UI later, we'll add policies then.
