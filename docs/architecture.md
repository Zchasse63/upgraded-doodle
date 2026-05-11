# Architecture

> **Status**: v0 design. Sandbox phase (TSG-owned PushPress). No code yet beyond scaffolds. PR 1 in the next session implements the first vertical slice.

## 1. Goal

Mirror PushPress events for the "Sauna + Cold Plunge Add-on" plan into Glofox so TSG's existing operator workflows (member analytics, capacity tracking, attendance reports in [Meridian](https://github.com/Zchasse63/meridian-fresh)) continue to work for Cigar City CrossFit members the same as they do for standalone TSG members.

**Non-goals (v1):**
- Bi-directional sync. We never write to PushPress beyond outbound push messages.
- A separate analytics surface. Meridian remains TSG's analytics layer.
- Multi-tenant. One PushPress company at a time (the sandbox is the TSG-owned PushPress account; production will be CC's).

## 2. System diagram

```
                                       webhook (POST)
                                       webhook-signature header
PushPress  ───────────────────────►   Supabase Edge Function
(events)                              /functions/v1/pushpress-webhook
                                              │
                                              ├─ verify signature
                                              ├─ dedup check (event_log)
                                              ├─ dispatch by event name
                                              │
                                              ▼
                              ┌───────── handlers ──────────┐
                              │ enrollment.created          │
                              │ reservation.created   ──────┼──► Glofox REST
                              │ checkin.created             │   (gf-api.aws.glofox.com)
                              │ class.canceled (fan-out)    │
                              │ ...                         │
                              └─────────────┬───────────────┘
                                            │
                                            ▼
                            ┌────── support tables ──────┐
                            │ plan_mappings (read)        │
                            │ slot_mappings (read/write)  │
                            │ members_link (read/write)   │
                            │ event_log (write)           │
                            │ pending_refunds (write)     │
                            └─────────────────────────────┘
```

Single entry point, dispatch internally. Webhook providers prefer one URL per subscription — splitting into a function per event makes ops harder, not easier.

## 3. Data flow per event

### 3a. `enrollment.created`

PushPress fires when a CC member buys the Sauna add-on plan.

1. Verify signature, dedup against `event_log`.
2. Look up PushPress `customer.id` → Glofox `user.id` in `members_link`.
   - If missing: fetch full customer detail via `pushPress.customers.get()`. Try matching the email against Glofox `POST /v3.0/namespaces/members/retrieve`.
   - If still missing: auto-create a Glofox lead via `POST /2.1/branches/{branchId}/leads`. Insert into `members_link` with `linked_via='auto_create_lead'`.
3. Look up `plan_mappings[pushpress_plan_id]` to get the Glofox `membership_id`, `plan_code`, and `payment_method`.
4. POST `/2.2/branches/{branch}/users/{userId}/memberships/{membershipId}/plans/{planCode}/purchase` with `payment_method` from the mapping (externally-billed).
5. Record the returned `userMembershipId` somewhere — we need it later when PushPress cancels and we need to cancel the matching Glofox membership.

**Open question Q1:** what `payment_method` value lets Glofox skip the charge attempt? Likely `complimentary` or a custom-configured staff-only method. See [`open-questions.md`](open-questions.md).

### 3b. `enrollment.status.changed`

PushPress fires when a subscription status flips (`active → canceled`, `pendcancel`, `paused`, etc.).

1. Verify, dedup.
2. Read the new status from `data.status`.
3. If status is `canceled` or `pendcancel`: POST `/v3.0/memberships/{userMembershipId}/cancel`.
4. Otherwise: log and ack. Glofox doesn't have a clean "paused" concept across all membership types — treat non-cancel transitions as informational for now.

**Where do we store `userMembershipId`?** Decision: extend `members_link` is wrong (one customer can have multiple memberships). Better: add a `pushpress_enrollment_links` table in a follow-up migration when this handler lands. PR 1 punts: it records the assigned Glofox `userMembershipId` in `event_log.glofox_response` and the cancel handler queries `event_log` by `pushpress_event = 'enrollment.created'` and `payload->'data'->>'id' = $pushpress_enrollment_id`. Functional but ugly; refactor when traffic justifies.

### 3c. `reservation.created`

The hot path. Member books a sauna slot in PushPress.

1. Verify, dedup.
2. Resolve PushPress `customer.id` → Glofox `user.id` via `members_link` (if missing, treat as failure → `pending_refunds[reason=member_unlinkable]`).
3. Resolve PushPress `reservedId` (the calendar-item UUID) → Glofox `event_id` via `slot_mappings`. On cache miss:
   - Read the PushPress class via `pushPress.classes.get({ id: reservedId })` to learn `start` and `end` timestamps.
   - Query Glofox `GET /2.0/events?date_from={start - 60s}&date_to={start + 60s}` and find the matching event by start time and class type.
   - INSERT into `slot_mappings`.
   - If still no match: `pending_refunds[reason=slot_unmappable]` + ops alert. CC staff refunds, we re-check the schedule.
4. POST `/2.3/branches/{branch}/bookings` with `{ user_id, event_id, charge: false, pay_gym: false }`.
5. On 4xx capacity error: `pending_refunds[reason=capacity_full]` + PushPress push notification to member + Slack alert.
6. On success: record booking ID in `event_log.glofox_response` for later cancel reference.

### 3d. `reservation.canceled`

1. Verify, dedup.
2. Look up the Glofox booking ID from `event_log` (search for prior `reservation.created` with same `data.id`).
3. DELETE `/2.3/branches/{branch}/bookings/{bookingId}`.
4. Idempotent: if the booking is already gone, log success.

### 3e. `reservation.waitlisted`

Same as `reservation.created` but pass `status: WAITING` to Glofox if its booking endpoint supports it. **Open question:** does Glofox's `POST /2.3/.../bookings` accept a `waitlist` flag, or do we need a different endpoint? Verify in sandbox.

### 3f. `checkin.created`

1. Verify, dedup.
2. Resolve customer → Glofox user.
3. POST `/2.0/attendances` with `{ user_id, event_id, attended_at }`.

The checkin payload is a discriminated union by `kind` (`class | appointment | event | open`). For sauna, only `kind: "class"` is relevant; ignore others.

### 3g. `class.canceled`

1. Verify, dedup.
2. Look up every prior `reservation.created` for this `reservedId` in `event_log`.
3. Fan out DELETE `/2.3/branches/{branch}/bookings/{bookingId}` for each.
4. Record the fan-out outcomes in the original `event_log` row's `glofox_response`.

### 3h. `customer.details.changed`

Debouncing applies: PushPress can fire this multiple times per second when a member edits their profile. Without debouncing we'd hammer Glofox.

- v1 (PR 1–2): no debouncing, accept the overhead. The traffic is low.
- v2: pgmq or a write-back queue table flushed every N seconds.

The handler PUTs `/2.0/members/{userId}` with name/email/phone updates.

### 3i. `enrollment.deleted`

Treat as a hard cancel: POST `/v3.0/memberships/{userMembershipId}/cancel`. Note PushPress's docstring: *"Enrollment deleted, most often because of a failed initial payment."* — we may want to backfill telemetry distinguishing this from a normal cancel.

## 4. Cross-cutting concerns

### 4a. Signature verification

PushPress's signature scheme is non-standard. From [`docs/pushpress/sdk-reference.md`](pushpress/sdk-reference.md) § Webhooks:

- Header: `webhook-signature`
- Algorithm: HMAC-SHA256
- Key: UTF-8 bytes of the per-subscription `signingSecret`
- Message: `JSON.stringify(parsedBody.data)` — NOT the raw HTTP body
- Encoding: lowercase hex

The SDK ships `pushPress.validateWebhook()` (and a standalone `validateWebhook` function) that do this correctly. We import the SDK from `https://esm.sh/@pushpress/pushpress@1.15.0` and call `validateWebhook`. If that path proves flaky in Deno, fall back to a hand-rolled implementation in `_shared/signature.ts` mirroring the SDK's `webhook-security-custom.ts` exactly.

**Don't try to verify against the raw body.** Whitespace and key-ordering in the original request body don't matter — only the `data` sub-object's content matters.

### 4b. Idempotency

PushPress's retry policy is undocumented (see [open-questions Q2](open-questions.md)). Assume retries can happen. Dedup strategy:

```
dedup_key = SHA-256( `${event}|${data.id}|${data.companyId}|${created}` )
```

Inserted into `event_log` with a `unique` constraint. On conflict, return 200 OK without re-running the handler — PushPress sees success, stops retrying.

This works for all events because every payload has an `event`, a `data.id` (the resource UUID), a `data.companyId`, and a `created` timestamp. (For the slimmed `enrollment.deleted` payload that only has `data.id`, fall back to `${event}|${data.id}|${created}`.)

### 4c. Capacity & overbooking

Sauna slots are physically shared between CC (via PushPress) and standalone TSG (via Glofox). Capacity baseline (per [handoff §4c](handoff-from-meridian.md)):

| Slot | Physical | PushPress (CC) | Glofox (TSG) |
|---|---|---|---|
| Standard sauna class | 12 | 6 | 6 |

Neither system has a pre-booking interception hook. **Overbooking detection happens at Glofox's booking-create time:** if Glofox returns a capacity error, we route the PushPress reservation to `pending_refunds` and notify the member. CC staff refunds within ~1 business hour (PushPress has no refund API).

**This depends on Glofox returning a clean 4xx with a parseable error when capacity is full.** That's [open question Q4](open-questions.md) — verify in sandbox before going live.

### 4d. Lazy slot mapping vs pre-sync

Pre-syncing the schedule is wasted work — bookings often arrive minutes before the slot. Lazy mapping (resolve on first reservation, cache forever) is cheaper and simpler. Requires the Glofox schedule to be pre-populated 7+ days out, which is the standard Glofox recurring-template behavior. CC staff publishes sauna slots in PushPress; TSG/CC ops syncs matching Glofox events (one-page runbook to be written).

### 4e. Auto-refund is hybrid

The system handles everything except the actual refund click in PushPress (no API). Detection, member notification, ops alert, queue entry → all automatic. The refund itself is a manual step with a soft SLA of 1 business hour.

### 4f. Observability

- **Structured logs to stdout** — Supabase Edge Functions pipe stdout to the platform's log drain. Use JSON: `{"level":"info","event":"reservation.created","duration_ms":143,"glofox_status":201}`.
- **`event_log` is the audit trail** — every webhook outcome lands here, queryable by status and timestamp.
- **`pending_refunds` is the operator's queue** — a simple Supabase UI / admin page (out of scope for v1; ops checks the table directly).
- **Slack alerts** — overbookings, signature failures, unmappable slots. Webhook URL via env var.

No external tracing in v1. Sentry can be added later if needed.

## 5. Failure modes & responses

| Failure | Response |
|---|---|
| Signature invalid | 401 to PushPress. Record in `event_log` with `signature_verified=false`. Slack alert on N failures in T minutes (replay or compromised secret). |
| Duplicate event (dedup hit) | 200 OK, no handler re-run. Returns count of duplicates seen. |
| Unknown event name | 200 OK, record with `handler_status='skipped'`. Don't retry. |
| Glofox 5xx | Mark `event_log.handler_status='failed'`, no PushPress retry response (200 OK to stop retries). Manual replay via admin tool (PR 2+). |
| Glofox 4xx (capacity full) | Enqueue `pending_refunds`, push member, Slack ops. 200 OK to PushPress. |
| Glofox auth fails (200+success:false) | Same as 5xx — credential issue, page ops. |
| Customer can't be linked | Enqueue `pending_refunds[reason=member_unlinkable]`. |
| Slot can't be mapped | Enqueue `pending_refunds[reason=slot_unmappable]`. |

## 6. What we explicitly DON'T do in v1

- **No Glofox CDC subscriptions.** Glofox webhook subscription requires emailing `glofox.APISupport@abcfitness.com`. The one-way mirror doesn't need it. Add later if drift detection becomes useful.
- **No appointments handling.** Sauna isn't appointment-based.
- **No write-back to PushPress** beyond `messages.push.send` for member notifications.
- **No multi-company.** One PushPress company at a time. The `PUSHPRESS_COMPANY_ID` env var is single-valued.
- **No retry/backoff on outbound Glofox calls.** Glofox is reliable enough; if a call fails we mark the event failed and ops investigates. (Add retry in PR 2+ if it becomes a real problem.)

## 7. PR-by-PR roadmap

| PR | Scope | Status |
|---|---|---|
| **PR 0** | Repo bootstrap: docs, schema, scaffolds (this commit) | Done — in this session |
| **PR 1** | Signature verification, idempotency, `_shared/` foundations, single working event handler (`reservation.created` end-to-end against TSG-PushPress sandbox + Glofox sandbox) | Next session |
| **PR 2** | Remaining 8 event handlers; admin replay endpoint | After PR 1 |
| **PR 3** | Operator UI (or pgmq write-back queue, whichever PR 2 surfaces as the priority gap) | After PR 2 |
| **PR cutover** | Swap sandbox creds for CC's real PushPress creds; live | After PR 3 |
