-- 0006_enrollment_links.sql
-- ============================================================================
-- Durable store of PushPress enrollment_id → Glofox userMembershipId.
-- Needed so enrollment.status.changed + enrollment.deleted handlers can find
-- the Glofox membership to cancel without re-querying the API on every call.
--
-- Populated by:
--   (a) enrollment.created handler on success (going forward) — `enrollment_created`
--   (b) backfill from existing event_log success rows (bottom of this migration)
--   (c) DQ7 self-healing fallback in cancel handlers — `glofox_query`
--
-- DQ7 note: Glofox's purchaseMembership response shape did not echo
-- userMembershipId in our 4 test purchases — those rows backfill with NULL
-- and the cancel handler's fallback will recover the ID via Glofox query
-- and UPDATE this row in place.
-- ============================================================================

create table pushpress_enrollment_links (
  pushpress_enrollment_id    text         primary key,
  pushpress_customer_id      text         not null,
  glofox_user_membership_id  text,
  linked_at                  timestamptz  not null default now(),
  linked_via                 text         not null
    check (linked_via in ('enrollment_created', 'glofox_query', 'manual'))
);

create index pushpress_enrollment_links_customer_idx
  on pushpress_enrollment_links (pushpress_customer_id);

create index pushpress_enrollment_links_glofox_idx
  on pushpress_enrollment_links (glofox_user_membership_id)
  where glofox_user_membership_id is not null;

comment on table pushpress_enrollment_links is
  'PushPress enrollment_id → Glofox userMembershipId. Required by cancel handlers. glofox_user_membership_id may be NULL if Glofox did not echo it at purchase time (DQ7) — recover via Glofox query in the cancel path.';

alter table pushpress_enrollment_links enable row level security;

-- Backfill from existing successful enrollment.created rows.
-- glofox_user_membership_id will be NULL for the 4 historical rows (DQ7) —
-- still useful as a customer-id index entry. The cancel handler's Glofox
-- fallback populates the ID lazily and UPDATEs the row.
insert into pushpress_enrollment_links
  (pushpress_enrollment_id, pushpress_customer_id, glofox_user_membership_id, linked_via)
select
  payload->'data'->>'id',
  payload->'data'->>'customerId',
  glofox_response->>'userMembershipId',
  'enrollment_created'
from event_log
where pushpress_event = 'enrollment.created'
  and handler_status   = 'success'
  and payload->'data'->>'id' is not null
  and payload->'data'->>'customerId' is not null
on conflict (pushpress_enrollment_id) do nothing;
