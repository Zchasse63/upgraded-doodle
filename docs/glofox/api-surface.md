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

### Create a user (was: create a lead)

```
POST /2.0/register
Content-Type: application/json

{
  "email": "...",        // will be normalized to lowercase by the bridge
  "first_name": "...",
  "last_name": "...",
  "phone": "",
  "password": "<random-with-a-digit>!"
}
```

**Use case**: PushPress customer can't be matched to an existing Glofox member — auto-create a Glofox user with the PushPress contact info.

**Why not `/2.1/branches/{branchId}/leads`?** That endpoint is deprecated — verified 2026-05-11. Every request returns `INVALID_USER_TYPE` regardless of body. `/2.0/register` works and creates a `type: "member"` user (better for tracking anyway — we're not doing CRM-style lead qualification).

**Password requirements**: must contain at least one **digit** (`PASSWORD_RULE_DIGIT` error otherwise). The bridge generates `Bridge-<16 hex chars>!` which can rarely (~1 in 2M) be digit-free. The user never logs in directly (their login lives in PushPress / CC's app); for direct Glofox access they'd reset via forgot-password.

**Response (success)**:
```json
{
  "success": true,
  "user": {
    "_id": "<glofox_user_id>",
    "first_name": "...",
    "last_name": "...",
    "email": "...",
    "membership": { "type": "payg" },
    ...
  }
}
```

The `user._id` is the Glofox user UUID used in subsequent membership-purchase / booking calls.

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
  "payment_method": "cash",
  "start_date": "1778543804",
  "promo_code": "TESTCODE"
}
```

**Use case**: PushPress fires `enrollment.created` — assign the matching Glofox membership without Glofox attempting to charge.

**Path parameters**:
- `branchId` — the TSG branch UUID from `x-glofox-branch-id` (yes, it appears in the path AND the header)
- `userId` — Glofox user UUID from the lead/member lookup
- `membershipId` — from `plan_mappings` (NOEQL = `69fe0e2c238a9b2cd206fa15`)
- `planCode` — from `plan_mappings` (Glofox memberships have variant codes for different billing schedules)

**Body fields (verified 2026-05-11)**:
- `payment_method: "cash"` — Q1 resolution. `complimentary` is not API-accessible even when enabled on the plan; `direct_debit` requires a customer-side mandate that doesn't exist for bridged users. `cash` is staff_only=true and API-accessible. Combined with the `TESTCODE` 100%-off promo, produces a $0-net assignment with no charge flow.
- `start_date` — must be a **Unix timestamp STRING** (e.g. `"1778543804"`). Glofox's PHP backend prepends `@` and feeds the value to `DateTime::__construct`, which only accepts Unix-style strings. Sending `"2026-05-11"` produces "Double timezone specification" error. Use [`parseStartDateToUnix`](../../supabase/functions/_shared/glofox-client.ts) helper.
- `promo_code` — omit when null/undefined (don't send the field at all). Sending `null` may be treated as "apply empty promo".

**Response (success)**:
```json
{
  "success": true,
  "message": "CART_LEGACY_PURCHASE_SUCCESS",
  "message_code": "CART_LEGACY_PURCHASE_SUCCESS",
  "status": "SUCCESS",
  "invoice_id": "<uuid>"
}
```

**⚠️ Glofox does NOT return the `userMembershipId` at purchase time.** Only an `invoice_id` (which is a different identifier, not usable for cancel). The membership IS assigned (visible in dashboard) but we can't capture the ID needed for later cancel. Combined with the lack of a "list user's memberships" endpoint (see [open question Q13](../open-questions.md)), cancel handlers can't auto-resolve `userMembershipId` and fall back to a manual-ops path. The bridge persists `(enrollment_id, customer_id, null)` to `pushpress_enrollment_links` for forensic correlation.

**Failure modes**:
- Member already has an active membership with no end-date: `200 success:false CART_LEGACY_PURCHASE_ERROR`
- Invalid payment_method: `200 success:false` with descriptive error
- Invalid promo_code: `200 success:false`

### Cancel a membership

```
POST /v3.0/memberships/{userMembershipId}/cancel
```

**Use case**: PushPress fires `enrollment.status.changed → canceled` or `enrollment.deleted`.

**Path parameter**: `userMembershipId` would be the per-assignment identifier (NOT the plan-level `membershipId`). However, **Glofox does not expose this ID** — `purchaseMembership` doesn't echo it (see above), and no REST endpoint lists a user's memberships. The bridge cannot reliably auto-cancel; manual cancel in the Glofox dashboard is required. See [Q13](../open-questions.md).

**Responses (verified 2026-05-11)**:
- **200** on successful cancel
- **404** with body `{"status":"NOT_FOUND","error_code":"MEMBER_NOT_FOUND","message":"Member not found"}` for unknown IDs

The bridge's `cancelMembership` treats 404 as idempotent success.

---

## Bookings

### Resolve event by start time (lazy slot mapping)

```
GET /2.0/events?start=1715443200&end=1715446800
```

**Use case**: first time we see a PushPress reservation for a given calendar item, find the matching Glofox event so we can cache the mapping.

**Query params**:
- `start` / `end` — Unix seconds, narrow window around the PushPress class start time (e.g. ±60 seconds)
- **WARNING**: Glofox **silently ignores** the older `date_from`/`date_to` names that some PushPress-side docs referenced. With wrong param names you get a default page of today's events with no error — verified 2026-05-11 against the TSG branch. Always use `start`/`end`. The slot resolver also validates the returned event's `time_start` falls within the requested window as defense in depth.

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
  "model": "event",
  "model_id": "<same as event_id>",
  "charge": false,
  "join_waiting_list": true    // OPTIONAL — set true when the class is full
}
```

**Use case**: PushPress fires `reservation.created` (or `reservation.waitlisted`) → mirror as a Glofox booking.

**Critical fields** (verified against OpenAPI spec 2026-05-12 — schema `BookingEventAsAMember` / `BookingEventAsAStaff`):
- `model: "event"` (singular) + `model_id` — **REQUIRED.** Without them: `400 MODEL_IS_REQUIRED, MODEL_ID_IS_REQUIRED`. The plural form (`"events"`) is rejected with `INVALID_MODEL`. Input/output asymmetry: stored canonical value is `"events"` but input must be `"event"`.
- `charge: false` — do not attempt to charge the user (no Stripe / card flow).
- `join_waiting_list: true` — set this **only** when the class is full and the customer should land on the waitlist instead of being rejected. Send `false` or omit otherwise. When set, response `Booking.status` is `"WAITING"` (vs `"BOOKED"`). Previously we tried `status: "WAITING"` which the API silently ignored — that was a misread; the right field is `join_waiting_list`.

**Not in the schema** (we previously sent these but they're undocumented):
- `pay_gym: false` — was in the older `BookingRequest` schema as a payment_method enum value, not a separate field. Harmless to send but useless.

**Response (success)**:
```json
{
  "success": true,
  "Booking": {
    "_id": "<booking_id>",
    "user_id": "...",
    "event_id": "...",
    "model": "events",
    "model_id": "<event_id>",
    "model_name": "Open Sauna",
    "status": "BOOKED",
    "type": "events",
    ...
  }
}
```

Save `Booking._id` in `event_log.glofox_response.bookingId` for the cancel handler.

**Failure modes**:
- Capacity full: `4xx` (exact shape unverified — still [open question Q4](../open-questions.md))
- User has no eligible membership: same path
- Event doesn't exist (stale `slot_mappings` row): re-resolve via `GET /2.0/events`

### Cancel a booking

```
DELETE /2.3/branches/{branchId}/bookings/{bookingId}
```

**Use case**: PushPress fires `reservation.canceled` or `class.canceled` (fan-out to every linked booking).

**Verified responses (2026-05-11)**:
- **204 No Content** on successful cancel
- **400** with body `{"success":false,"message":"Booking Not Found","message_code":"BOOKING_NOT_FOUND",...}` for an already-canceled or non-existent booking (NOT 404)

Treat both `204` and `400 + BOOKING_NOT_FOUND` as idempotent success. The bridge's `cancelBooking` wrapper does this.

**Notes**:
- For `class.canceled` we fan out **sequentially** — `GlofoxClient.pace()` enforces 200ms between calls; parallel fan-out would exceed Glofox's 10 RPS limit. 6 bookings ≈ 1.2s total, acceptable for a rare event.

---

## Payment methods

### List configured payment methods

```
GET /2.1/branches/{branchId}/payment-methods
```

**Use case**: enumerate the payment methods configured for TSG's branch. Needed to pick the right `payment_method` value for externally-billed membership assignments ([Q1](../open-questions.md)) and to know which methods are restricted to staff/integrator use.

**Response fields**: `_id`, `branch_id`, `active`, `staff_only`, `type_id`, `provider` (`name`, `charge_percentage`, `fixed_charge`, `publishable_key`, `account_id`, `tokenization_handler`), `iframe` (`parameters`, `domain`, `full_path`).

**Notes**:
- `staff_only: true` flags methods only callable by staff/integrator credentials (e.g. a comped-membership type a staff member would assign manually). These are the prime candidates for our externally-billed flow.
- Canonical Glofox method IDs that may appear: `cash`, `credit_card`, `bank_transfer`, `paypal`, `direct_debit`, `complimentary`, `wallet`. Custom methods configured in the dashboard appear here too.
- Read-only call — safe to run against production creds during Q1 investigation.

---

## Attendance

### Mark a check-in

```
POST /2.0/attendances
Content-Type: application/json

{
  "model": "bookings",
  "model_ids": ["<booking_id>"]
}
```

**Use case**: PushPress fires `checkin.created` with `kind: "class"` and `result: "success"`.

**Field shape (verified via OpenAPI spec `AttendanceRequest` 2026-05-12)**:
- `model: "bookings"` (literal, no other values accepted)
- `model_ids: [<booking_id>, ...]` — array of **BOOKING IDs** (not event IDs and not user IDs)

That's the whole body — no `user_id`, no `event_id`, no timestamp. Glofox derives everything from the booking record. Our earlier probe sent event IDs with `model: "events"` (plural) and got back a different user's booking in the response — that's because Glofox was matching the event against any booking, not because it was attributing attendance correctly. The Q12 attribution mystery is resolved: pass the right booking_id, get the right attribution.

**Handler integration**: `checkin-created` looks up the prior `reservation.created` event_log row (filtered by `reservedId` AND `customerId` so multi-user events disambiguate), extracts `glofox_response.bookingId`, passes that to `markAttendance`.

**Notes**:
- Only `kind: "class"` events trigger this handler. Appointment / event / open-gym checkins are skipped.

---

---

## Endpoints we LOOKED for but couldn't find

These don't exist (or aren't accessible to our auth). Documented so we don't re-search.

| Goal | Tried (all 404 / Route not found / WRONG_URL) |
|---|---|
| List a user's assigned memberships | `/2.0/branches/{b}/users/{u}/memberships`, `/2.0/users/{u}/memberships`, `/2.0/users/{u}/user-memberships`, `/2.0/private-memberships?user_id=...`, `/2.0/memberships?user_id=...` (param ignored), `/v3.0/users/{u}/memberships` |
| Waitlist a user explicitly | `status: "WAITING"` on `POST /bookings` (silently ignored — creates confirmed booking) |
| Get a single membership by user_membership_id | `/v3.0/memberships/{id}` (only `/cancel` works) |
| Get user's transactions | `/2.0/transactions?user_id=...`, `/2.0/branches/{b}/users/{u}/transactions` |

For both **list-user-memberships** and **waitlist endpoint**, the resolution path is to email `glofox.APISupport@abcfitness.com`. See [Q12, Q13, OQ-1](../open-questions.md).

---

## Endpoint inventory (quick reference)

| Method | Path | Used by handler |
|---|---|---|
| `POST` | `/v3.0/namespaces/members/retrieve` | `enrollment.created`, `reservation.created`, `reservation.waitlisted` (lookup) |
| `POST` | `/2.0/register` | auto-create lead fallback (uses `/2.0/register` not deprecated `/2.1/.../leads` — verified 2026-05-11) |
| `PUT` | `/2.0/members/{userId}` | `customer.details.changed` |
| `POST` | `/2.2/branches/{branchId}/users/{userId}/memberships/{membershipId}/plans/{planCode}/purchase` | `enrollment.created` |
| `POST` | `/v3.0/memberships/{userMembershipId}/cancel` | `enrollment.status.changed`, `enrollment.deleted` (manual-only — Glofox doesn't expose `userMembershipId`) |
| `GET` | `/2.0/events?start=...&end=...` | `reservation.created`, `reservation.waitlisted` (lazy slot mapping) |
| `POST` | `/2.3/branches/{branchId}/bookings` | `reservation.created`, `reservation.waitlisted` (waitlist flag ignored — gated handler) |
| `DELETE` | `/2.3/branches/{branchId}/bookings/{bookingId}` | `reservation.canceled`, `class.canceled` |
| `POST` | `/2.0/attendances` | `checkin.created` (attribution unverified — see Q12) |
| `GET` | `/2.0/memberships?private=any` | one-shot tooling: plan enumeration for seeding |
| `GET` | `/2.0/programs` | one-shot tooling: program/category enumeration |
| `GET` | `/2.1/branches/{branchId}/payment-methods` | one-shot Q1 probe (not a runtime handler) |
| `GET` | `/2.0/members/{userId}?private=any` | one-shot diagnostic: returns user's PRIMARY membership only (not NOEQL) |
| `GET` | `/2.0/bookings?user_id=...&limit=N` | diagnostic only |

9 events → 9 endpoint patterns plus a handful of read-only diagnostic / tooling endpoints. Bookings POST is reused for create + (would-be) waitlist; bookings DELETE is reused for reservation.canceled + class.canceled fan-out.
