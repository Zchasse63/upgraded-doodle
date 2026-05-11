# PushPress webhook events

Catalog of the events the middleware subscribes to, their payload shapes, and what the handler does with each. For the full list of events available (21 customer events + 2 lifecycle events), see [`sdk-reference.md` § Operations § ManageWebhooks](sdk-reference.md).

Every webhook payload has this envelope:

```typescript
{
  event: string;     // event name, e.g. "reservation.created"
  created: number;   // Unix seconds when the event occurred
  data: object;      // event-specific payload (see per-event sections below)
}
```

The signature header `webhook-signature` is HMAC-SHA256 over `JSON.stringify(body.data)` — NOT the full envelope and NOT the raw HTTP body. See [`sdk-reference.md` § Webhooks](sdk-reference.md#webhooks).

---

## Events the middleware handles (9)

These are the events we subscribe to. Anything else PushPress sends gets a 200 OK and a `handler_status='skipped'` row in `event_log`.

### `enrollment.created`

A customer bought a plan. For us this means a CC member bought the Sauna add-on.

**Payload (`data` is `Enrollment`)**:

```typescript
{
  id: string;                  // PushPress enrollment UUID
  customerId: string;
  companyId: string;
  planId?: string | null;      // PushPress plan UUID — key for plan_mappings lookup
  billingSchedule: { period, interval };
  status: EnrollmentStatus;
  startDate: string | null;
  endDate: string | null;
  // ...etc, see sdk-reference.md § Enrollment for full type
}
```

**Handler**:
1. Resolve customer → Glofox user via `members_link` (create if missing).
2. Look up `plan_mappings[data.planId]` → `{glofox_membership_id, glofox_plan_code, payment_method}`.
3. POST `/2.2/branches/{branch}/users/{userId}/memberships/{membershipId}/plans/{planCode}/purchase` with `payment_method` from the mapping.
4. Record the Glofox `userMembershipId` in `event_log.glofox_response`.

**Failure modes**: unknown `planId` (not in `plan_mappings`), customer can't be linked, Glofox rejects the purchase.

### `enrollment.status.changed`

Subscription status transitioned. The most common case for us is `active → canceled`.

**Payload**: same `Enrollment` shape as above, with the new `status` value.

**Handler**:
1. If `data.status` is `canceled` or `pendcancel`: look up the prior `userMembershipId` from `event_log` and POST `/v3.0/memberships/{userMembershipId}/cancel`.
2. Otherwise: log + ack. Glofox doesn't have a clean "paused" semantic across all membership types.

### `enrollment.deleted`

PushPress's docstring: *"Enrollment deleted, most often because of a failed initial payment."* Treat as hard cancel.

**Payload (slim)**:

```typescript
{ id: string }   // PushPress enrollment UUID
```

**Handler**: same as cancel — find prior `userMembershipId`, POST cancel to Glofox.

### `reservation.created`

A customer reserved a slot. Hot path.

**Payload (`data` is `Reservation`)**:

```typescript
{
  id: string;                       // reservation UUID
  reservedId: string;               // UUID of the class/event/appointment — NOT the slot
  customerId?: string | null;
  companyId?: string | null;
  registrationTimestamp: number;    // Unix seconds
  status: "reserved";               // (other values for waitlist/cancel events)
  templateId?: string | null;
}
```

**Handler**:
1. Resolve customer → Glofox user.
2. Resolve `reservedId` → Glofox `event_id` via `slot_mappings`; lazy lookup against Glofox if missing.
3. POST `/2.3/branches/{branch}/bookings` with `{ user_id, event_id, charge: false, pay_gym: false }`.
4. On capacity error: enqueue `pending_refunds[reason=capacity_full]`, push member, alert ops.

### `reservation.canceled`

Member cancelled their reservation in PushPress.

**Payload**: same `Reservation` shape, `status: "canceled"` (or `"late-canceled"` — note the hyphen).

**Handler**: look up the Glofox booking ID from the prior `reservation.created` event, DELETE it.

### `reservation.waitlisted`

Slot was full; PushPress put the member on the waitlist.

**Payload**: same `Reservation` shape, `status: "waitlisted"`.

**Handler**: POST `/2.3/branches/{branch}/bookings` with a waitlist flag (verify Glofox endpoint behavior in sandbox — see [open question Q4](../open-questions.md)).

### `checkin.created`

Member arrived and was marked attendant.

**Payload (`data` is `Checkin`, discriminated union by `kind`)**:

For sauna we only care about `kind: "class"`:

```typescript
{
  id: string;
  customer: string;        // NOTE: `customer`, not `customerId`
  company: string;         // NOTE: `company`, not `companyId`
  timestamp: number;       // Unix seconds
  classId: string;
  kind: "class";
  role: "attendee" | "staff" | "coach" | "assistant";
  result: "success" | "failure";
  // ...etc
}
```

**Handler**:
1. Skip unless `kind === "class"` AND `role === "attendee"` AND `result === "success"`.
2. Resolve customer → Glofox user.
3. Resolve `classId` → Glofox event via `slot_mappings`.
4. POST `/2.0/attendances` with `{ user_id, event_id, attended_at: timestamp }`.

### `class.canceled`

CC cancelled a class (instructor sick, weather, etc.).

**Payload (`data` is `Class`)**:

```typescript
{
  id: string;
  start: number;          // Unix seconds
  end: number;
  title: string | null;
  reservations?: Reservation[];   // includes all attendees
  // ...etc
}
```

**Handler**: for every prior `reservation.created` linked to this `id`, DELETE the Glofox booking. Fan-out.

### `customer.details.changed`

Member edited their profile (name, email, phone, address).

**Payload**: full `Customer` snapshot of the new state.

**Handler**: PUT `/2.0/members/{userId}` with the changed fields. Debouncing punted to v2 — see [`architecture.md` § 3h](../architecture.md#3h-customerdetailschanged).

---

## Events we do NOT subscribe to

For each, the rationale.

| Event | Why skip |
|---|---|
| `customer.created` | We create the Glofox user lazily on first reservation/enrollment. Subscribing here would create lots of empty Glofox leads. |
| `customer.deleted` | We don't delete Glofox users on PushPress delete. Different retention policies. Audit-only event. |
| `customer.status.changed` | Status (lead → member → ex-member) is internal PushPress state; doesn't map to Glofox cleanly. |
| `checkin.updated` | We rely on the create event. Updates are rare and usually corrections that don't affect Glofox attendance counts. |
| `checkin.failed` | We don't mirror failed checkins. Operator sees them in PushPress. |
| `checkin.deleted` | Same reasoning — slim payload, hard to act on. |
| `appointment.*` | Sauna isn't appointment-based. |
| `memberapp.updated` | No SDK type — undocumented payload shape. |
| `reservation.noshowed` | No SDK type — undocumented payload shape. Could revisit. |
| `app.installed` / `app.uninstalled` | We're not building a PushPress marketplace app. |

If a PushPress webhook sends us one of these events anyway (e.g. via a mistake in subscription config), the dispatcher records it as `handler_status='skipped'` and returns 200 OK.

---

## Verifying a recorded payload locally

Once we have a real signed payload (capture one from PushPress's webhook dashboard's "test" feature, save to `tests/fixtures/<event>.json` along with the signature header), unit tests can verify the signature path without hitting PushPress:

```typescript
// pseudo-code; PR 1 fills this in
import { validateWebhook } from "https://esm.sh/@pushpress/pushpress@1.15.0/funcs/validateWebhook.js";

const body = await Deno.readTextFile("tests/fixtures/reservation.created.json");
const signature = "abc123...";  // captured header value
const result = await validateWebhook({
  request: new Request("https://example.com", {
    method: "POST",
    body,
    headers: { "webhook-signature": signature },
  }),
  secret: TEST_SIGNING_SECRET,
});
```

This sidesteps having to stand up a fake HTTP server.
