# Glofox

Class management and analytics platform. The Sauna Guys' (TSG's) system of record for memberships, bookings, attendance, transactions, and member profiles. Cross-referenced via [Meridian](https://github.com/Zchasse63/meridian-fresh) for operator workflows.

For the full per-endpoint surface that the middleware calls, see [`api-surface.md`](api-surface.md). This page is the orientation layer.

## What we use it for

- **Resolving customers**: looking up Glofox `user.id` from email via `POST /v3.0/namespaces/members/retrieve`; creating leads when no match exists.
- **Assigning memberships**: when a CC member buys the Sauna add-on in PushPress, we assign the corresponding Glofox membership without charging.
- **Cancelling memberships**: when PushPress fires `enrollment.status.changed → canceled`.
- **Booking class slots**: when a CC member books a sauna session in PushPress.
- **Cancelling bookings**: when a CC member or staff cancels.
- **Marking attendance**: on `checkin.created`.
- **Resolving event/class IDs**: lazy-cache lookup against the Glofox schedule by start time.

We do NOT subscribe to Glofox's CDC webhooks in v1 (subscription requires emailing `glofox.APISupport@abcfitness.com` — out of scope for the sandbox phase).

## Authentication (3-header — all required)

| Header | Value |
|---|---|
| `x-api-key` | The TSG Glofox API key |
| `x-glofox-api-token` | The TSG Glofox API token |
| `x-glofox-branch-id` | The TSG Glofox branch UUID |

**Missing any one header → Glofox returns `HTTP 200` with `{ success: false }` in the body.** This is a known quirk: always check both the HTTP status AND `response.success`. From Meridian's `lib/glofox/client.ts`:

```typescript
if (!response.ok || !response.success) {
  throw new GlofoxApiError(...)
}
```

The branch UUID is the same value as the location for single-location studios (TSG is one location).

## Server URL

| Environment | URL |
|---|---|
| Production | `https://gf-api.aws.glofox.com/prod/` |
| Sandbox | (Meridian uses production; sandbox is reserved for higher-volume testing per ABC Fitness — see Meridian docs) |

## Rate limits (verified, not theoretical)

| Environment | Limit |
|---|---|
| Live | 10 req/sec |
| Sandbox | 3 req/sec |
| Burst | 1000 / 300s |

Meridian's `lib/glofox/client.ts` paces page-walking at **120ms between pages** to stay well under the live limit. Bridge traffic is much lower volume than Meridian's bulk syncs, so we can rely on the same pacing.

## Quirks (you will hit these)

### 1. `200 OK` with `success: false`

The single most common failure mode. Caused by:

- Missing one of the three auth headers
- Wrong branch UUID
- Mis-cased header name (HTTP says it's fine, Glofox apparently doesn't always tolerate it)

**Always** parse the response body and check `success` before trusting the response.

### 2. Transactions use a non-REST endpoint

For transaction history, Glofox uses an Analytics endpoint that doesn't look like REST:

```
POST /Analytics/report
{
  "model": "TransactionsList",
  "filters": { "start": "1714200000", "end": "1716800000" }
}
```

Notes:
- `start` / `end` are **STRING** unix-second timestamps. Not numbers, not ISO 8601.
- Response unwraps via `TransactionsList.details[]`, not `data[]`.
- The bridge does not currently use this endpoint — payments are handled in PushPress.

### 3. Programs use POST, not GET

```
POST /v3.0/locations/{branch}/search-programs
```

If you GET it, you get nothing. Not a typo.

### 4. Pagination is `page=1`-based, `limit=100`

Some endpoints return `has_more`; others require length-based detection (if you got 100 results, try page 2; if you got <100, stop).

### 5. `branch` and `location` are interchangeable

For single-location studios (TSG is one location), the branch UUID and the location UUID are the same value. Endpoints inconsistently use both terms — same value either way.

### 6. Bookings vs attendances use DIFFERENT model shapes

Both endpoints require `model`-style fields, but the names and reference IDs are different:

| Endpoint | `model` | `model_id` / `model_ids` | Reference type |
|---|---|---|---|
| `POST /2.3/.../bookings` | `"event"` (singular) | `model_id: <event_id>` (singular) | event_id |
| `POST /2.0/attendances` | `"bookings"` (plural) | `model_ids: [<booking_id>]` (plural array) | **booking_id** (not event_id!) |

Verified via OpenAPI spec 2026-05-12. The attendance endpoint takes booking IDs because Glofox uses them to derive both the user_id and event_id from the booking record. Sending event IDs to attendances returns a booking for someone else's booking on that event (that bit us during probing — Q12).

Bookings has an input/output asymmetry: input must be `model: "event"` (singular), but Glofox stores it as `model: "events"` (plural) on the booking record. Sending `"events"` on input is rejected with `INVALID_MODEL`.

### 7. `cancelBooking` returns 400 (not 404) for missing bookings

`DELETE /2.3/.../bookings/{id}` returns:
- **204 No Content** on successful cancel
- **400** with body `{"success":false,"message":"Booking Not Found","message_code":"BOOKING_NOT_FOUND",...}` when the booking doesn't exist (already canceled or never existed)

Treat BOTH `404` AND `400+BOOKING_NOT_FOUND` as idempotent success. Our `cancelBooking` wrapper does this. By contrast, `POST /v3.0/memberships/{id}/cancel` correctly returns 404 for missing IDs.

### 8. `purchaseMembership` doesn't return `userMembershipId`

`POST /2.2/branches/{branchId}/users/{userId}/memberships/{membershipId}/plans/{planCode}/purchase` returns:

```json
{
  "success": true,
  "message": "CART_LEGACY_PURCHASE_SUCCESS",
  "message_code": "CART_LEGACY_PURCHASE_SUCCESS",
  "status": "SUCCESS",
  "invoice_id": "<uuid>"
}
```

There is no `userMembershipId` field. The membership IS assigned (verifiable in the dashboard), but the ID needed to later cancel it is not exposed at purchase time.

### 9. No REST endpoint lists a user's memberships

We tried every plausible path. None return a user's assigned memberships:

- `/2.0/branches/{branchId}/users/{userId}/memberships` → 404
- `/2.0/users/{userId}/memberships` → 404
- `/2.0/branches/{branchId}/users/{userId}/user-memberships` → 404
- `/2.0/private-memberships?user_id=...` → 404
- `/2.0/memberships?user_id=...` → param ignored, returns the plan catalog
- `/v3.0/users/{userId}/memberships` → 404
- `/2.0/members/{userId}?private=any` → returns ONE `membership` field = the user's PRIMARY (PAYG), not NOEQL/private assignments

**Combined with quirk #8, this means we cannot programmatically cancel a membership unless we capture the `userMembershipId` at purchase time — which Glofox doesn't expose.** Cancel handlers degrade gracefully (skip with Slack alert); manual cancel in the dashboard is required. See [`docs/open-questions.md`](../open-questions.md) Q13.

### 10. Waitlist field is `join_waiting_list` (boolean), not `status: "WAITING"`

`POST /2.3/.../bookings` waitlist control is `join_waiting_list: true`. The field we tried first (`status: "WAITING"`) is silently ignored — that was a misread, not a Glofox bug. Set `join_waiting_list: true` only when the class is full; response will then have `Booking.status: "WAITING"` instead of `"BOOKED"`. Documented in OpenAPI schemas `BookingEventAsAMember` / `BookingEventAsAStaff` (verified 2026-05-12).

### 11. `/2.0/register` requires a digit in the password

Returns `PASSWORD_RULE_DIGIT` if the password is all letters + symbols. Our `generatePlaceholderPassword` builds `Bridge-<16 hex chars>!` which can rarely (~1 in 2M calls) be digit-free. Best-effort: append a digit unconditionally or retry on this specific error.

### 12. `/2.0/memberships` defaults to `private: false`

To see private/internal memberships (like NOEQL), pass `?private=any`:
- `?private=false` (default) → public only
- `?private=true` → private only
- `?private=any` → both

### 13. Email lookup is case-sensitive

`POST /v3.0/namespaces/members/retrieve` requires the email exactly as stored. PushPress can store mixed-case (e.g. `Zchasse89@gmail.com`); always `.toLowerCase()` before sending.

## Cross-reference: Meridian's Glofox knowledge

The Meridian repo at `~/Code/meridian-fresh/` has a battle-tested Glofox REST client. Key files for porting / reference:

| Meridian file | Purpose |
|---|---|
| `lib/glofox/client.ts` | REST client with the 3-header auth, rate-limit pacing, success-flag checking |
| `lib/glofox/transformers.ts` | Glofox response → internal shape conversions. Encodes shape knowledge that isn't in any spec. |
| `lib/glofox/sync-engine.ts` | The hourly read-only sync. Confirms there's no existing membership-write code path. |
| `CLAUDE.md` § "Glofox quirks" | The same quirks documented in this file, distilled to a paragraph |

**Port these patterns to Deno-flavored TS for `_shared/glofox-client.ts`.** Don't re-derive from scratch.

## Reference

- **Per-endpoint surface**: [`api-surface.md`](api-surface.md)
- **Glofox OpenAPI 2.2 spec**: Owned by ABC Fitness. The PushPress-side handoff session retrieved a copy as `specs/glofox-openapi.yaml`. If we need to refer to it, ask the user for the local file path.
