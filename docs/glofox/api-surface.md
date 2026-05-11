# Glofox API surface used by the middleware

Every Glofox endpoint the bridge calls. Source: original PushPress-side handoff doc (which built against Glofox's OpenAPI 2.2 spec) + verified patterns from Meridian's `lib/glofox/client.ts`.

All requests go to base URL `https://gf-api.aws.glofox.com/prod/` and carry the three required auth headers:

```
x-api-key:           <GLOFOX_API_KEY>
x-glofox-api-token:  <GLOFOX_API_TOKEN>
x-glofox-branch-id:  <GLOFOX_BRANCH_ID>
```

Missing any one → `200 OK { success: false }`.

---

## Members & leads

### Retrieve member by email

```
POST /v3.0/namespaces/members/retrieve
Content-Type: application/json

{ "email": "member@example.com" }
```

**Use case**: resolve a PushPress customer's Glofox `user.id` on first encounter (before falling back to lead creation).

**Response**: member record with `user.id` if found. Empty / error if not. **Verify response shape in sandbox** — Meridian's sync engine queries members in bulk via a different shape; this lookup-by-email path may not be exercised in production.

### Create a lead

```
POST /2.1/branches/{branchId}/leads
Content-Type: application/json

{
  "email": "...",
  "first_name": "...",
  "last_name": "...",
  "phone": "...",
  "status": "new"
}
```

**Use case**: PushPress customer can't be matched to an existing Glofox member — auto-create a Glofox lead with the PushPress contact info.

**Notes**:
- GloFox treats every signup as a "lead" — there's no separate "member" creation API. Real "member" status is derived from purchase activity.
- Per Meridian's CLAUDE.md: "Never filter the leads sync by status — most legitimate people have null status from GloFox; the sync engine defaults null to 'new'."
- The created lead's `user.id` is used in subsequent membership-purchase / booking calls.

### Update member contact info

```
PUT /2.0/members/{userId}
Content-Type: application/json

{
  "first_name": "...",
  "last_name": "...",
  "email": "...",
  "phone": "..."
}
```

**Use case**: PushPress fires `customer.details.changed` — sync the new contact info to Glofox so reports/exports reflect the latest.

**Notes**:
- Debouncing required at scale (PushPress fires this frequently during profile edits). v1 accepts the overhead; v2 debounces.

---

## Memberships

### Assign a membership (externally-billed)

```
POST /2.2/branches/{branchId}/users/{userId}/memberships/{membershipId}/plans/{planCode}/purchase
Content-Type: application/json

{
  "payment_method": "<see open-questions.md Q1>",
  "promo_code": null,
  "start_date": "2026-05-11"
}
```

**Use case**: PushPress fires `enrollment.created` — assign the matching Glofox membership without Glofox attempting to charge.

**Path parameters**:
- `branchId` — the TSG branch UUID from `x-glofox-branch-id` (yes, it appears in the path AND the header)
- `userId` — Glofox user UUID from the lead/member lookup
- `membershipId` — from `plan_mappings`
- `planCode` — from `plan_mappings` (Glofox memberships have variant codes for different billing schedules)

**Critical**: the `payment_method` value determines whether Glofox tries to charge. Candidate values (need sandbox verification):
- `complimentary` — possibly accepts any membership with no charge
- `external` — explicit "externally billed" marker
- A custom staff-only payment type configured in the Glofox dashboard

This is [**open question Q1**](../open-questions.md), the gating blocker for PR 1.

### Cancel a membership

```
POST /v3.0/memberships/{userMembershipId}/cancel
```

**Use case**: PushPress fires `enrollment.status.changed → canceled` or `enrollment.deleted`.

**Path parameter**: `userMembershipId` is returned by the assign call (not the same as the plan's `membershipId`). Store it on the `enrollment.created` event handler's success path so the cancel handler can find it.

---

## Bookings

### Resolve event by start time (lazy slot mapping)

```
GET /2.0/events?date_from=1715443200&date_to=1715446800
```

**Use case**: first time we see a PushPress reservation for a given calendar item, find the matching Glofox event so we can cache the mapping.

**Query params**:
- `date_from` / `date_to` — Unix seconds, narrow window around the PushPress class start time (e.g. ±60 seconds)

**Notes**:
- Caller filters the response by class type (sauna vs. cold plunge vs. yoga) since multiple events may overlap.
- Pagination: `page=1`-based, default `limit=100`. Use length-based detection (no `has_more` field documented for this endpoint).
- Cache result in `slot_mappings`.

### Create a booking

```
POST /2.3/branches/{branchId}/bookings
Content-Type: application/json

{
  "user_id": "...",
  "event_id": "...",
  "charge": false,
  "pay_gym": false
}
```

**Use case**: PushPress fires `reservation.created` → mirror as a Glofox booking.

**Critical fields**:
- `charge: false` — do not attempt to charge the user (no Stripe / card flow)
- `pay_gym: false` — do not deduct from the user's credit/class pack at Glofox; PushPress handles billing
- For `reservation.waitlisted`: include `status: "WAITING"` (or whatever the Glofox waitlist flag is — **verify in sandbox**, this is [open question Q4](../open-questions.md))

**Response**: includes the Glofox `booking.id`. Save in the `event_log.glofox_response` for the cancel handler.

**Failure modes**:
- Capacity full: `4xx` with parseable error → enqueue `pending_refunds`
- User has no eligible membership: same path
- Event doesn't exist (stale `slot_mappings` row): re-resolve via `GET /2.0/events`

### Cancel a booking

```
DELETE /2.3/branches/{branchId}/bookings/{bookingId}
```

**Use case**: PushPress fires `reservation.canceled` or `class.canceled` (fan-out to every linked booking).

**Notes**:
- Idempotent — calling DELETE on an already-deleted booking returns success (verify in sandbox; if not, swallow the 404).
- For `class.canceled` we fan out and may issue many concurrent DELETEs. Stay under the rate limit (10 RPS live), but a single class fan-out is unlikely to hit it.

---

## Attendance

### Mark a check-in

```
POST /2.0/attendances
Content-Type: application/json

{
  "user_id": "...",
  "event_id": "...",
  "attended_at": 1715443800
}
```

**Use case**: PushPress fires `checkin.created` with `kind: "class"` and `result: "success"`.

**Notes**:
- `attended_at` is Unix seconds.
- Only `kind: "class"` events trigger this handler. Appointment / event / open-gym checkins are skipped.

---

## Endpoint inventory (quick reference)

| Method | Path | Used by handler |
|---|---|---|
| `POST` | `/v3.0/namespaces/members/retrieve` | `enrollment.created`, `reservation.created` (lookup) |
| `POST` | `/2.1/branches/{branchId}/leads` | `enrollment.created`, `reservation.created` (fallback create) |
| `PUT` | `/2.0/members/{userId}` | `customer.details.changed` |
| `POST` | `/2.2/branches/{branchId}/users/{userId}/memberships/{membershipId}/plans/{planCode}/purchase` | `enrollment.created` |
| `POST` | `/v3.0/memberships/{userMembershipId}/cancel` | `enrollment.status.changed`, `enrollment.deleted` |
| `GET` | `/2.0/events?date_from=...&date_to=...` | `reservation.created` (lazy lookup) |
| `POST` | `/2.3/branches/{branchId}/bookings` | `reservation.created`, `reservation.waitlisted` |
| `DELETE` | `/2.3/branches/{branchId}/bookings/{bookingId}` | `reservation.canceled`, `class.canceled` |
| `POST` | `/2.0/attendances` | `checkin.created` |

9 events, 9 endpoint patterns. Roughly 1:1 (some events share endpoints — bookings is reused for create/waitlist/cancel).
