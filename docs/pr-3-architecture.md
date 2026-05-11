# PR 3 Architecture Blueprint

> Produced 2026-05-11. Authoritative for all work described in the PR 3 + Milestone B/C scope. Read `docs/pr-2-architecture.md` for handler + test conventions; this doc extends those patterns.

---

## Patterns and conventions found

**Handler signature** (`reservation-created.ts:41`, `enrollment-created.ts:38`):
```ts
export async function handleX(body: PushPressWebhookBody, deps: { supabase, glofox, pushpress }): Promise<HandlerResult>
```

**HandlerResult** (`_shared/types.ts:21`): `{ status: 'success'|'failed'|'skipped'|'filtered', error?, glofoxResponse? }`

**GlofoxClientShape** (`_shared/types.ts:60`): add every new Glofox method here, then stub in all three client classes (GlofoxClient, GlofoxReadOnlyClient, GlofoxMockClient) + the shape interface.

**Error handling**: catch `GlofoxApiError` explicitly; treat unknown errors as `status:'failed'`. Never let a handler throw — the dispatcher catches and records `failed` but doesn't enqueue a pending_refund automatically.

**pending_refunds.failure_reason** check constraint lists exact values — only extend via migration.

**Booking ID retrieval**: `event_log.glofox_response::jsonb->>'bookingId'` is the established pattern from `reservation-created.ts:123`.

**Dedup on enrollment.deleted**: payload only has `{id}`, no `companyId`. `computeDedupKey` already falls back to `""` for missing `companyId` — no change needed.

---

## Architectural decisions

### D1: `class.canceled` fan-out — sequential with per-booking error isolation

Run the DELETEs **sequentially** (one at a time) to respect Glofox's 10 RPS limit + the client's own 200ms `pace()`. With 6 bookings = 1.2s total, acceptable for a rare event. Each DELETE is independent; one failure must not prevent others. Use a simple `for` loop with `try/catch` per iteration. On per-booking failure: write to `pending_refunds[reason='class_cancel_glofox_failed']` (new constraint value). Store per-booking outcome map in `event_log.glofox_response`.

Rationale: parallel `Promise.allSettled` at concurrency 5 would exceed 10 RPS (5 × 5 = 25 RPS effective). Sequential is simpler + safer for a low-frequency event.

**Fan-out result stored as:**
```json
{ "results": [{"bookingId":"...", "ok": true}, {"bookingId":"...", "ok": false, "error":"..."}], "total": 3, "succeeded": 2, "failed": 1 }
```
If any failed: `status:'failed'`. If all succeeded: `status:'success'`. Zero bookings found: `status:'skipped'`.

### D2: `enrollment.status.changed` + `enrollment.deleted` — `pushpress_enrollment_links` lookup with Glofox fallback

Primary: look up `userMembershipId` from new `pushpress_enrollment_links` table by `pushpress_enrollment_id`. If missing (historical enrollments): query Glofox `GET /2.0/branches/{branchId}/users/{userId}/memberships` and find the NOEQL membership that is not canceled. Cache the recovered ID back into `pushpress_enrollment_links`. If Glofox query also fails to identify a unique membership: log `warn` + `status:'skipped'` (no cancel attempted).

Do NOT fail hard on missing link — the enrollment may have been created before the bridge was live.

### D3: `reservation.canceled` — `handler_status='success'` filter only, with out-of-order handling

Query: `event_log WHERE pushpress_event='reservation.created' AND payload->data->>'id' = $1 AND handler_status='success'`. Skip failed `reservation.created` rows — a failed booking create means no Glofox booking exists.

Out-of-order (cancel arrives before create): the query returns nothing → `status:'skipped'`, no error. Record `error:'no_prior_booking_found'` in `event_log` for ops visibility but return 200 OK.

### D4: `customer.details.changed` — mirror only first_name, last_name, email, phone

The PushPress payload is a full Customer snapshot. PUT to Glofox only: `{first_name, last_name, email, phone}`. Skip if `members_link` has no entry for this customer (`status:'skipped'`). Do not call `getOrCreateMemberLink` — this is a profile update, not a booking.

### D5: Slack alerts — simple text format, per-alert rate limit via `event_log` count check

Use Slack's incoming webhook with plain JSON `{text: "..."}`. Rate limit: before alerting, count the same alert type in `event_log` over the last 60 seconds; if count >= 5, suppress and log locally. Best-effort SELECT, not a transaction.

Alert triggers: 5xx Glofox errors, capacity_full overbooking, member_unlinkable, slot_unmappable, signature failures, class_cancel_glofox_failed.

### D6: Scheduled reconcile — new Edge Function + Supabase scheduler

Use a new `reconcile-cron` Edge Function. Accepts `Authorization: Bearer $CRON_SECRET` and is triggered by Supabase's cron scheduler (configured in `supabase/config.toml`). Falls back gracefully if `CRON_SECRET` empty (dev mode: no auth required). On audit completion, posts summary to Slack.

---

## Files to create

| Path | Purpose |
|---|---|
| `supabase/functions/pushpress-webhook/handlers/reservation-canceled.ts` | Look up prior booking, DELETE it |
| `supabase/functions/pushpress-webhook/handlers/class-canceled.ts` | Fan-out DELETE all linked bookings |
| `supabase/functions/pushpress-webhook/handlers/enrollment-status-changed.ts` | Cancel on canceled/pendcancel |
| `supabase/functions/pushpress-webhook/handlers/enrollment-deleted.ts` | Hard cancel via same path |
| `supabase/functions/pushpress-webhook/handlers/checkin-created.ts` | POST attendance |
| `supabase/functions/pushpress-webhook/handlers/customer-details-changed.ts` | PUT member info |
| `supabase/functions/pushpress-webhook/handlers/reservation-waitlisted.ts` | POST booking with waitlist flag |
| `supabase/functions/_shared/slack.ts` | `alertOps(supabase, event, detail)` helper |
| `supabase/functions/reconcile-cron/index.ts` | Scheduled reconciliation Edge Function |
| `supabase/migrations/0006_enrollment_links.sql` | `pushpress_enrollment_links` table + backfill |
| `supabase/migrations/0007_pending_refunds_class_cancel.sql` | Add `class_cancel_glofox_failed` reason |
| `supabase/migrations/0008_event_log_retention.sql` | OPT-IN pg_cron retention job |
| `tests/reservation-canceled.test.ts` | |
| `tests/class-canceled.test.ts` | |
| `tests/enrollment-status-changed.test.ts` | |
| `tests/enrollment-deleted.test.ts` | |
| `tests/checkin-created.test.ts` | |
| `tests/customer-details-changed.test.ts` | |
| `tests/reservation-waitlisted.test.ts` | |

## Files to modify

**`supabase/functions/_shared/types.ts`** — extend `GlofoxClientShape`:
- `cancelMembership(userMembershipId: string): Promise<void>`
- `cancelBooking(bookingId: string): Promise<void>`
- `createBookingWaitlisted(args: { userId, eventId }): Promise<{ _id: string }>`
- `markAttendance(args: { userId, eventId, attendedAt: number }): Promise<void>`
- `updateMember(args: { userId, firstName, lastName, email, phone?: string | null }): Promise<void>`
- `getMemberMemberships(userId: string): Promise<Array<{ _id: string; status: string; membershipId: string }>>`

**`supabase/functions/_shared/glofox-client.ts`** — implement on `GlofoxClient`:
- `cancelBooking`: `DELETE /2.3/branches/{branchId}/bookings/{bookingId}` — treat 404 as success
- `createBookingWaitlisted`: same as createBooking but adds `status: "WAITING"` (verify in sandbox)
- `cancelMembership`: `POST /v3.0/memberships/{userMembershipId}/cancel`
- `markAttendance`: `POST /2.0/attendances` with `{user_id, event_id, attended_at}`
- `updateMember`: `PUT /2.0/members/{userId}` with `{first_name, last_name, email, phone}`
- `getMemberMemberships`: `GET /2.0/branches/{branchId}/users/{userId}/memberships`

Add stubs to `GlofoxReadOnlyClient` (writes throw `GlofoxWriteBlocked`; reads delegate to inner) and `GlofoxMockClient`.

**`supabase/functions/_shared/mappings.ts`**:
- `getEnrollmentLink(supabase, pushpressEnrollmentId): Promise<{ glofoxUserMembershipId: string | null } | null>`
- `insertEnrollmentLink(supabase, enrollmentId, customerId, userMembershipId, linkedVia): Promise<void>` — ON CONFLICT DO NOTHING
- `lookupMemberMembership(glofox, supabase, glofoxUserId, pushpressEnrollmentId): Promise<string | null>` — Glofox fallback with cache-back
- Extend `enqueuePendingRefund` reason union to include `'class_cancel_glofox_failed'`

**`supabase/functions/pushpress-webhook/index.ts`**:
- Wire all 7 new handlers in `HANDLERS`
- Add Q10 staleness check after dedup hit (warn if age > 86400s)

**`supabase/config.toml`**:
- Add `[functions.reconcile-cron]` with `verify_jwt = false` and `schedule = "0 6 * * *"`

**`supabase/migrations/0005_plan_mappings_seed.sql`**:
- Fix drift: change `payment_method='complimentary'` → `'cash'` (live DB is already cash)

**`supabase/functions/pushpress-webhook/handlers/enrollment-created.ts`**:
- After successful purchase, call `insertEnrollmentLink(supabase, data.id, data.customerId, purchase.userMembershipId, 'enrollment_created')`

---

## Migrations — full SQL

### 0006_enrollment_links.sql

```sql
-- 0006_enrollment_links.sql
-- ============================================================================
-- Durable store of PushPress enrollment_id → Glofox userMembershipId.
-- Needed so enrollment.status.changed + enrollment.deleted handlers can find
-- the Glofox membership to cancel without re-querying the API.
--
-- Populated by:
--   (a) enrollment.created handler on success (going forward)
--   (b) backfill from existing event_log success rows (this migration)
--   (c) DQ7 self-healing fallback in cancel handlers
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
  'PushPress enrollment_id → Glofox userMembershipId. DQ7: ID may be null if Glofox did not echo it at purchase time.';

alter table pushpress_enrollment_links enable row level security;

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
```

### 0007_pending_refunds_class_cancel.sql

```sql
-- 0007_pending_refunds_class_cancel.sql
-- ============================================================================
-- Adds 'class_cancel_glofox_failed' to the failure_reason check constraint.
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
```

### 0008_event_log_retention.sql

```sql
-- 0008_event_log_retention.sql
-- ============================================================================
-- OPT-IN payload retention via pg_cron. Nulls event_log.payload for rows
-- older than RETENTION_DAYS (default 90). Audit metadata preserved.
-- Safe in environments without pg_cron — extension check before scheduling.
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
  'Nulls event_log.payload for rows older than retention_days (default 90).';

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'tsg_bridge_prune_event_log_payloads',
      '0 3 * * *',
      $$select tsg_bridge_prune_event_log_payloads(90)$$
    );
    raise notice 'pg_cron job registered.';
  else
    raise notice 'pg_cron not available — skipping. Run tsg_bridge_prune_event_log_payloads() manually.';
  end if;
end;
$$;
```

---

## Handler designs (pseudocode)

### `reservation-canceled.ts`
```
data = { id, reservedId, customerId, companyId }
1. Guard: missing data.id → failed
2. Query event_log: SELECT glofox_response->>'bookingId' WHERE pushpress_event='reservation.created'
   AND payload->data->>'id' = data.id AND handler_status='success' LIMIT 1
3. If no row: return { status:'skipped', error:'no_prior_booking_found' }
4. bookingId = row.glofox_response.bookingId
5. glofox.cancelBooking(bookingId)  -- 404 treated as success inside client
6. return { status:'success', glofoxResponse: { bookingId } }
CATCH GlofoxApiError → status:'failed', alertOps if 5xx
```

### `class-canceled.ts`
```
data = { id (calendar_item_id), start, end, title }
1. Guard: missing data.id → failed
2. Query event_log: all successful reservation.created for this reservedId
3. If none: return { status:'skipped', error:'no_bookings_to_cancel' }
4. Sequential for-loop (respect rate limit):
     try cancelBooking → push {bookingId, ok:true}
     catch → push {bookingId, ok:false, error}, enqueuePendingRefund, alertOps
5. status = anyFailed ? 'failed' : 'success'
6. return { status, glofoxResponse: { total, succeeded, failed, results } }
```

### `enrollment-status-changed.ts`
```
data = { id, customerId, status, ... }
1. Guard: missing data.id or data.customerId → failed
2. If status NOT in ['canceled', 'pendcancel']:
   return { status:'skipped', error:'non_cancel_transition:'+status }
3. link = getEnrollmentLink(supabase, data.id)
4. If !link or !link.glofoxUserMembershipId:
   memberLink = selectMemberLink(supabase, data.customerId)
   if !memberLink: return { status:'failed', error:'member_not_linked' }
   userMembershipId = lookupMemberMembership(glofox, supabase, memberLink.glofoxUserId, data.id)
   if !userMembershipId: return { status:'skipped', error:'membership_not_found_in_glofox' }
5. glofox.cancelMembership(userMembershipId)
6. return { status:'success', glofoxResponse: { userMembershipId } }
```

### `enrollment-deleted.ts`
```
data = { id }  -- slim payload
1. Guard: missing data.id → failed
2. link = getEnrollmentLink(supabase, data.id)
3. If !link: return { status:'skipped', error:'no_enrollment_link_for_deleted_id' }
4. If !link.glofoxUserMembershipId: return { status:'skipped', error:'membership_id_unknown_cannot_cancel' }
5. glofox.cancelMembership(link.glofoxUserMembershipId)
6. return { status:'success', glofoxResponse: { userMembershipId: link.glofoxUserMembershipId } }
```

### `checkin-created.ts`
```
data = { id, customer, company, timestamp, classId, kind, role, result }  -- note: customer/company not customerId/companyId
1. Guard: missing data.id → failed
2. If kind !== 'class' || role !== 'attendee' || result !== 'success':
   return { status:'filtered', error:'checkin_kind_or_role_filtered' }
3. Guard: missing customer or classId → failed
4. memberLink = selectMemberLink(supabase, data.customer)
   if !memberLink: return { status:'failed', error:'member_not_linked' }
5. slotMapping = selectSlotMapping(supabase, data.classId)
   if !slotMapping: return { status:'failed', error:'slot_not_mapped' }
6. glofox.markAttendance({ userId, eventId, attendedAt: data.timestamp })
7. return { status:'success' }
```

### `customer-details-changed.ts`
```
data = { id, name: { first, last }, email, phone, ... }
1. Guard: missing data.id → failed
2. memberLink = selectMemberLink(supabase, data.id)
   if !memberLink: return { status:'skipped', error:'member_not_linked' }
3. Extract firstName/lastName/email/phone with type guards
4. glofox.updateMember({ userId, firstName, lastName, email, phone })
5. return { status:'success' }
```

### `reservation-waitlisted.ts`
```
Same flow as reservation-created except step 6:
glofox.createBookingWaitlisted({ userId, eventId })
```

---

## `_shared/slack.ts`

```ts
export async function alertOps(
  supabase: SupabaseClient,
  event: string,
  detail: Record<string, unknown>,
): Promise<void>
```

- Reads `SLACK_OPS_WEBHOOK_URL` lazily.
- If URL empty: log info, return.
- Throttle: count `event_log` failures matching `event` in last 60s; if >=5, suppress.
- Format: `{text: "[tsg-cc-bridge] ${event}: ${JSON.stringify(detail).slice(0,500)}"}`.
- Failure to POST: log warn, do not throw.

---

## `reconcile-cron` Edge Function

`supabase/functions/reconcile-cron/index.ts`:
- Bearer auth (skip check if `CRON_SECRET` empty — dev mode)
- Port `auditReservations` + `auditEnrollments` from `scripts/reconcile.ts` (no replay)
- Post summary to Slack
- Return JSON `{ reservationGaps, enrollmentGaps }`

`supabase/config.toml`:
```toml
[functions.reconcile-cron]
verify_jwt = false
schedule = "0 6 * * *"
```

---

## `index.ts` staleness check (Q10)

After dedup hit, query original `received_at`. If > 24h, warn:
```ts
if (insert.duplicate) {
  const { data: prior } = await supabase
    .from("event_log").select("received_at").eq("dedup_key", dedupKey).maybeSingle();
  if (prior?.received_at) {
    const ageSeconds = (Date.now() - new Date(prior.received_at).getTime()) / 1000;
    if (ageSeconds > 86400) {
      console.error(JSON.stringify({
        level:"warn", msg:"stale_replay_detected", event: body.event,
        age_seconds: Math.floor(ageSeconds), original_received_at: prior.received_at,
      }));
    }
  }
  return ok({ status: "duplicate" });
}
```

---

## Build sequence

1. **Migrations**: write + apply 0006, 0007, 0008
2. **Fix 0005 content drift** (file edit only)
3. **Extend `_shared/types.ts`** with new Glofox methods
4. **Extend `_shared/glofox-client.ts`** — implement on all 3 client classes
5. **Extend `_shared/mappings.ts`** — enrollment_links helpers + reason union
6. **Write `_shared/slack.ts`**
7. **Modify `handlers/enrollment-created.ts`** — call `insertEnrollmentLink` on success
8. **Write all 7 new handlers** (order: reservation-canceled, enrollment-status-changed, enrollment-deleted, checkin-created, customer-details-changed, reservation-waitlisted, class-canceled)
9. **Write `reconcile-cron/index.ts`**
10. **Update `index.ts`** — wire handlers, add Q10 staleness check
11. **Update `supabase/config.toml`** — reconcile-cron block
12. **Write tests** (one file per handler)
13. **Review** with `feature-dev:code-reviewer`
14. **Simplify** with `simplify` skill
15. **Deploy** both Edge Functions
16. **Set `SLACK_OPS_WEBHOOK_URL`** in Supabase secrets (user provides URL)
17. **Verify** each handler with a real PushPress webhook (or replay)

---

## Tests to add (titles)

**reservation-canceled.test.ts**: happy / no-prior / failed-prior-skipped / 404-success / 500-failed / missing-id

**class-canceled.test.ts**: 2-bookings-all-succeed / no-bookings / one-fails / all-fail / missing-id

**enrollment-status-changed.test.ts**: canceled-link-found / pendcancel-link-found / paused-skipped / link-missing-glofox-fallback-found / fallback-not-found / member-not-linked / glofox-error

**enrollment-deleted.test.ts**: link-found / link-not-found / link-found-but-id-null

**checkin-created.test.ts**: happy / kind-appointment-filtered / role-coach-filtered / result-failure-filtered / member-not-linked / slot-not-mapped / missing-customer

**customer-details-changed.test.ts**: happy / not-linked-skipped / missing-id / glofox-error

**reservation-waitlisted.test.ts**: happy / non-sauna-filtered / member-unlinkable / slot-unmappable

---

## Open questions

**OQ-1** (must verify before reservation.waitlisted goes live): Glofox waitlist field shape. Until confirmed in sandbox, handler should skip with `error:'waitlist_field_unverified'` if `GLOFOX_WAITLIST_VERIFIED` env var not set. Optional gate.

**OQ-2** (Milestone B — DQ7 resolution): Verify the `GET /2.0/branches/{branchId}/users/{userId}/memberships` response shape — specifically `_id` field + `membershipId` correspondence. The Glofox fallback lookup depends on this.

**OQ-3** (Slack format): Plain text vs Block Kit. Plain text works in all configs; no decision needed.

---

## Risks and gotchas

1. **`enrollment.deleted` has no customerId.** If `pushpress_enrollment_links` was never populated for that enrollment, handler cannot cancel and skips silently. Monitor `handler_status='skipped' AND pushpress_event='enrollment.deleted'`.

2. **`class.canceled` races with `reservation.canceled`.** Idempotent 404 handling in `cancelBooking` resolves it: whichever DELETE hits second gets 404 and returns success.

3. **`checkin-created` uses `data.customer` not `data.customerId`.** Getting this wrong produces `member_not_linked` for every checkin.

4. **Glofox rate limit under class.canceled.** Sequential fan-out (NOT parallel) is required. 6 bookings × 200ms pace = 1.2s.

5. **`reconcile-cron` must reimplement audit logic.** Do not import from `scripts/` (those use `Deno.exit`). Standalone port.
