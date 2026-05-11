# PR 1 Architecture Blueprint

> Produced by `feature-dev:code-architect` agent on 2026-05-11 after the unified-PushPress state change. Authoritative over [`pr-1-plan.md`](pr-1-plan.md) where they conflict (specifically: idempotency model in §6, and member-resolution dependencies in §7). [`open-questions.md`](open-questions.md) Q9 is resolved by this blueprint.

## Doc fixes needed before implementation

1. **`docs/architecture.md` system diagram is stale.** It shows no filter step between "dispatch" and "handlers." Needs an `isSaunaClassType?` decision node. Not a code blocker — documentation drift only.
2. **`docs/architecture.md` § 3c step 2 implies the member email is on the `Reservation` payload.** It is not. `Reservation` carries only `customerId`. Member link resolution requires `pushpress.getCustomer(customerId)` to obtain the email. This affects the `PushPressClient` and `getOrCreateMemberLink` signatures.
3. **`docs/pr-1-plan.md` two-phase write description is incorrect.** Steps 4+5 describe INSERT-pending then UPDATE-duplicate. On a dedup collision the INSERT itself fails with Postgres `23505` — there is no pending row to UPDATE. Correct model is single INSERT with conflict detection. §6 is authoritative.
4. **`docs/open-questions.md` Q9 uses `'skipped'` and `'filtered'` interchangeably.** Decision: `'filtered'` is a new distinct status value (migration 0002). `'skipped'` = known event name, no handler registered. `'filtered'` = handler exists but sauna filter rejected the payload. Both return 200 OK to PushPress. Ops needs the distinction.

---

## 1. Files to create / modify

### `supabase/functions/_shared/types.ts` — NEW

Canonical shared types. All `_shared/` modules import from here; nothing imports from `index.ts`.

```typescript
export type PushPressEventName =
  | "enrollment.created" | "enrollment.status.changed" | "enrollment.deleted"
  | "reservation.created" | "reservation.canceled" | "reservation.waitlisted"
  | "checkin.created" | "class.canceled" | "customer.details.changed";

export interface PushPressWebhookBody {
  event: string;
  created: number;                         // Unix seconds
  data: Record<string, unknown>;
}

export interface HandlerResult {
  status: "success" | "failed" | "skipped" | "filtered";
  error?: string;
  glofoxResponse?: unknown;
}

export type HandlerStatus =
  | "pending" | "success" | "failed" | "skipped" | "duplicate" | "filtered";

export type GlofoxConfig = {
  apiKey: string; apiToken: string; branchId: string; baseUrl?: string;
};

export type MemberLink = {
  pushpressCustomerId: string; glofoxUserId: string; email: string;
};

export type SlotMapping = {
  pushpressCalendarItemId: string; glofoxEventId: string; classType: string | null;
};
```

No external deps. No I/O.

---

### `supabase/functions/_shared/signature.ts` — NEW

```typescript
export async function verifyPushPressSignature(
  parsedBody: { data: unknown; [k: string]: unknown },
  providedSignature: string,
  signingSecret: string,
): Promise<boolean>
```

Pure HMAC-SHA256. ~25 lines. Message bytes = `new TextEncoder().encode(JSON.stringify(parsedBody.data))`. Key imported via `crypto.subtle.importKey("raw", ..., {name:"HMAC",hash:"SHA-256"}, false, ["sign"])`. Digest encoded as lowercase hex. Comparison via byte-by-byte XOR over Uint8Array — no `===` on hex strings (timing oracle). Returns `false` on any error. Never throws.

---

### `supabase/functions/_shared/dedup.ts` — NEW

```typescript
import type { PushPressWebhookBody } from "./types.ts";
export async function computeDedupKey(body: PushPressWebhookBody): Promise<string>
```

Input: `` `${body.event}|${(body.data as any).id ?? ""}|${(body.data as any).companyId ?? ""}|${body.created}` ``. Output: lowercase hex SHA-256 via `crypto.subtle.digest`. Pure, no I/O.

---

### `supabase/functions/_shared/filter.ts` — NEW

The Q9 sauna gate. Pure function, no DB, no API calls.

```typescript
export function isSaunaClassType(classTypeName: string | null | undefined): boolean
export function getSaunaClassTypeAllowlist(): readonly string[]
```

Source: `Deno.env.get("SAUNA_CLASS_TYPE_ALLOWLIST") ?? ""` — comma-separated, parsed at module load. Compare case-insensitive trimmed. `null`/`undefined` → `false`. Empty env var → allowlist `[]` → every call returns `false`. On first call with empty allowlist, emit one structured-log warning.

---

### `supabase/functions/_shared/event-log.ts` — NEW

```typescript
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { HandlerStatus } from "./types.ts";

export async function insertEventLog(
  supabase: SupabaseClient,
  args: {
    dedupKey: string; event: string; companyId?: string;
    signatureVerified: boolean; handlerStatus: HandlerStatus;
    handlerError?: string; durationMs?: number;
    payload: unknown; glofoxResponse?: unknown;
  },
): Promise<{ duplicate: boolean }>

export async function updateEventLog(
  supabase: SupabaseClient,
  dedupKey: string,
  update: {
    handlerStatus: HandlerStatus; handlerError?: string;
    durationMs: number; glofoxResponse?: unknown;
  },
): Promise<void>
```

`insertEventLog`: catches `error.code === "23505"` → `{duplicate: true}`. Other DB errors throw. `updateEventLog` called only when previous insert returned `{duplicate:false}`.

---

### `supabase/functions/_shared/glofox-client.ts` — NEW

Deno port of Meridian's `lib/glofox/client.ts`. No retry in PR 1.

```typescript
export class GlofoxNotConfigured extends Error {}
export class GlofoxApiError extends Error {
  constructor(public readonly status: number, public readonly path: string, message: string)
}
export class GlofoxCapacityError extends GlofoxApiError {}

export type GlofoxEvent = { _id: string; time_start: number; name?: string }

export class GlofoxClient {
  constructor(cfg: GlofoxConfig)
  static fromEnv(): GlofoxClient   // throws GlofoxNotConfigured if any of 3 vars missing

  async retrieveMemberByEmail(email: string): Promise<{ _id: string } | null>
  async createLead(args: { email: string; firstName: string; lastName: string; phone?: string | null }): Promise<{ _id: string }>
  async getEventsByTimeRange(dateFrom: number, dateTo: number): Promise<GlofoxEvent[]>
  async createBooking(args: { userId: string; eventId: string }): Promise<{ _id: string }>
}
```

Private `request<T>()`: inject 3 auth headers (`x-api-key`, `x-glofox-api-token`, `x-glofox-branch-id`); parse JSON; if `json?.success === false` → `GlofoxApiError(400)`; if `!res.ok` → `GlofoxCapacityError` if body matches `/capaci|full/i`, else `GlofoxApiError(res.status)`. `createBooking` always sends `{ charge: false, pay_gym: false }`. Inter-call 200ms pacing.

---

### `supabase/functions/_shared/pushpress-client.ts` — NEW

Hand-rolled thin client. **Does NOT import `@pushpress/pushpress`** — alpha SDK + esm.sh dual-export resolution at Deno cold-start is an unknown failure mode.

```typescript
export class PushPressClient {
  constructor(cfg: { apiKey: string; companyId: string; serverUrl?: string })
  static fromEnv(): PushPressClient

  async getCustomer(customerId: string): Promise<{
    id: string; email: string;
    name: { first: string; last: string };
    phone?: string | null;
  }>

  async getClass(classId: string): Promise<{
    id: string; classTypeName?: string | null;
    start: number; end: number;
  }>
}
```

Raw `fetch` with `API-KEY` and `company-id` headers. Base URL: `https://api.pushpress.com/v3`.

---

### `supabase/functions/_shared/mappings.ts` — NEW

```typescript
export async function getOrCreateMemberLink(
  supabase: SupabaseClient,
  glofox: GlofoxClient,
  pushpress: PushPressClient,
  pushpressCustomerId: string,
): Promise<MemberLink>

export async function getOrResolveSlotMapping(
  supabase: SupabaseClient,
  glofox: GlofoxClient,
  pushpressCalendarItemId: string,
  classStart: number,
  expectedClassTypeName: string | null,
): Promise<SlotMapping | null>

export async function enqueuePendingRefund(
  supabase: SupabaseClient,
  args: {
    reservationId: string; customerId: string; calendarItemId: string;
    reason: "capacity_full" | "slot_unmappable" | "member_unlinkable" | "glofox_5xx" | "other";
    glofoxError?: string;
  },
): Promise<void>
```

`getOrCreateMemberLink`: SELECT → hit → return. Miss → `pushpress.getCustomer()` → `glofox.retrieveMemberByEmail()` → hit → INSERT `linked_via='email_match'`. Miss → `glofox.createLead()` → INSERT `linked_via='auto_create_lead'`.

`getOrResolveSlotMapping`: SELECT → hit → return. Miss → `glofox.getEventsByTimeRange(classStart-60, classStart+60)` → find first event whose `name` matches `expectedClassTypeName` case-insensitively → INSERT `ON CONFLICT DO NOTHING` → return. No match → `null`.

`enqueuePendingRefund`: INSERT `ON CONFLICT (pushpress_reservation_id) DO NOTHING` — idempotent.

---

### `supabase/functions/pushpress-webhook/handlers/reservation-created.ts` — NEW

Extracted handler. Keeps `index.ts` thin.

```typescript
export async function handleReservationCreated(
  body: PushPressWebhookBody,
  deps: {
    supabase: SupabaseClient;
    glofox: GlofoxClient;
    pushpress: PushPressClient;
  },
): Promise<HandlerResult>
```

See §7 for flow.

---

### `supabase/functions/pushpress-webhook/index.ts` — MODIFY

Replace the 4 TODOs. 8 non-`reservation.created` handlers remain `return { status: "skipped" }`. Import types from `_shared/types.ts`.

Dispatcher:
1. Reject non-POST → 405.
2. Read body, JSON.parse → 400 on error.
3. `verifyPushPressSignature` → if false: best-effort `insertEventLog(signature_verified:false, status:'failed', error:'invalid_signature')` then 401.
4. `computeDedupKey`.
5. `insertEventLog(pending)` → if `{duplicate:true}` → 200 `{status:"duplicate"}`.
6. Dispatch to `HANDLERS[body.event]`. Unknown event → `{status:'skipped'}` directly.
7. `updateEventLog(dedupKey, {status, durationMs, glofoxResponse, handlerError})`.
8. Return 200 `{ok:true, status:result.status}`.

---

### `supabase/migrations/0002_filtered_status.sql` — NEW

```sql
alter table event_log
  drop constraint event_log_handler_status_check,
  add constraint event_log_handler_status_check
    check (handler_status in (
      'pending','success','failed','skipped','duplicate','filtered'
    ));
```

---

### `scripts/setup-webhook.ts` — NEW

```typescript
// Usage: deno run --allow-net --allow-env scripts/setup-webhook.ts <edge-function-url>
// Reads PUSHPRESS_API_KEY, PUSHPRESS_COMPANY_ID from env.
// POSTs https://api.pushpress.com/v3/webhooks with 9 event types.
// Prints full JSON response to stdout — signingSecret appears once, copy immediately.
```

Does NOT use the SDK. Raw `fetch`.

---

### `.env.example` — MODIFY

Add:

```
# Comma-separated PushPress classTypeName values to mirror to Glofox.
# Case-insensitive. Empty = all reservations are filtered (safe default).
# Example: "Sauna - 50min,Cold Plunge,Contrast Therapy"
SAUNA_CLASS_TYPE_ALLOWLIST=
```

---

### Test files — NEW

```
tests/
├── fixtures/
│   ├── reservation.created.valid.json
│   ├── reservation.created.signature.txt    pre-computed HMAC with TEST_SECRET
│   └── reservation.created.tampered.json
├── signature.test.ts
├── dedup.test.ts
├── filter.test.ts
└── integration.test.ts
```

---

## 2. Component / module boundaries

```
Request
  │
  ▼ index.ts (dispatcher only — no business logic)
  │
  ├─ _shared/signature.ts          verifyPushPressSignature(parsedBody, sig, secret)
  ├─ _shared/dedup.ts              computeDedupKey(body) → hex
  ├─ _shared/event-log.ts          insertEventLog(...) → {duplicate}
  │
  └─ [not duplicate] →
       handlers/reservation-created.ts
       │
       ├─ _shared/pushpress-client.ts  getClass(reservedId)
       ├─ _shared/filter.ts            isSaunaClassType()
       │   └─ [false] → return {status:'filtered'}
       ├─ _shared/mappings.ts          getOrCreateMemberLink (uses pushpress + glofox)
       ├─ _shared/mappings.ts          getOrResolveSlotMapping (uses glofox)
       ├─ _shared/glofox-client.ts     createBooking()
       │   └─ [GlofoxCapacityError] → enqueuePendingRefund(capacity_full)
       └─ return HandlerResult
  │
  └─ _shared/event-log.ts          updateEventLog(dedupKey, ...)
```

All state in Postgres. Edge Function is stateless across requests. Clients constructed per-request from env.

---

## 3. Q9 filtering design

**Decision: env-var allowlist by `classTypeName`, evaluated inside `handleReservationCreated`, after dedup insert.**

- **Where**: `SAUNA_CLASS_TYPE_ALLOWLIST` env var. Small list, infrequently changed, deploy = audit trail.
- **Key**: `Class.classTypeName` (human-readable, on the Class object). Not `typeId` (opaque UUID). Not `locationUuid` (unconfirmed config).
- **When**: after signature + dedup, inside the handler. The `getClass()` call needed for filtering is also needed for `classStart`. Co-locate to avoid partial handler logic in the dispatcher. Dedup must precede filter so every payload (including CF) gets an `event_log` row.
- **Recorded**: `handler_status='filtered'`, `handler_error='class_type_not_in_allowlist:<classTypeName>'`. Distinct from `'skipped'` (unknown event name).

---

## 4. Glofox client design (PR 1 subset)

Private `request<T>()` order:
1. Parse JSON (catch → null).
2. `json?.success === false` → `GlofoxApiError(400)` (missing-auth-header quirk).
3. `!res.ok` → body matches `/capaci|full/i` → `GlofoxCapacityError`; else `GlofoxApiError(status)`.
4. Return.

Capacity keyword match is best-guess pending Q4. `GlofoxCapacityError` as a subclass means future detection changes don't touch handler code.

---

## 5. Signature and dedup design

**Hand-roll. Do NOT import the SDK in the Edge Function.** Alpha + esm.sh dual-export = unknown Deno cold-start failure mode. Cold-start failure → 500s on every webhook until redeploy. 20 lines of `crypto.subtle` is the correct tradeoff.

SDK IS used in `scripts/setup-webhook.ts` (local one-shot, not Edge Function — acceptable).

---

## 6. Event_log / idempotency design

**Single INSERT. Conflict detection on return.**

```
insertEventLog(pending)
  → 23505 unique violation → {duplicate:true}  → return 200 "duplicate"
  → success                → {duplicate:false}
      → run handler (may crash here — row stays 'pending', ops signal)
      → updateEventLog(final status)
      → return 200
```

Pending row >5min = ops signal for hung handler. Signature failures: best-effort `insertEventLog(signature_verified:false, ...)` before 401. If DB unavailable, 401 still returned.

Migration 0002 adds `'filtered'` to CHECK constraint.

---

## 7. `reservation.created` handler — step-by-step

```
data = body.data  (Reservation: id, reservedId, customerId, companyId, registrationTimestamp)

1. GUARD: if !data.customerId
     enqueuePendingRefund(member_unlinkable)
     return { status:'failed', error:'missing_customerId' }

2. ppClass = await pushpress.getClass(data.reservedId)
     ON THROW → return { status:'failed', error:`getClass: ${err.message}` }

3. FILTER: if !isSaunaClassType(ppClass.classTypeName)
     return { status:'filtered' }
   // No pendingRefund — CF reservation, no refund needed.

4. memberLink = await getOrCreateMemberLink(supabase, glofox, pushpress, data.customerId)
     ON THROW →
       enqueuePendingRefund(member_unlinkable, err.message)
       return { status:'failed', error: err.message }

5. slotMapping = await getOrResolveSlotMapping(
     supabase, glofox,
     data.reservedId, ppClass.start, ppClass.classTypeName
   )
   if slotMapping === null →
     enqueuePendingRefund(slot_unmappable)
     return { status:'failed', error:'slot_unmappable' }

6. TRY:
     booking = await glofox.createBooking({
       userId: memberLink.glofoxUserId,
       eventId: slotMapping.glofoxEventId
     })
   CATCH GlofoxCapacityError:
     enqueuePendingRefund(capacity_full, err.message)
     return { status:'failed', error:'capacity_full', glofoxResponse: { error: err.message } }
   CATCH GlofoxApiError:
     return { status:'failed', error: err.message, glofoxResponse: { error: err.message } }

7. RETURN {
     status: 'success',
     glofoxResponse: { bookingId: booking._id }
   }
```

---

## 8. Test strategy

**Unit (`deno test --no-check tests/<file>.test.ts`):**

- `signature.test.ts`: 5 cases — valid; wrong secret; tampered data; empty sig; empty secret.
- `dedup.test.ts`: 4 cases — deterministic; field-change → different; null `id`; null `companyId`.
- `filter.test.ts`: 6 cases — sauna; CF; null; case-insensitive; whitespace; empty allowlist.

**Integration (local Supabase + mocked fetch for Glofox/PushPress):**

1. Valid signed `reservation.created` → 200, `event_log.handler_status='success'`, `glofox_response.bookingId` set, `slot_mappings` row created.
2. Same POST again → 200 `{status:"duplicate"}`, no second mocked Glofox call.
3. Tampered signature → 401, `event_log.signature_verified=false`.
4. CF class type in fixture → 200, `event_log.handler_status='filtered'`.
5. Glofox mock returns capacity error → 200, `event_log.handler_status='failed'`, `pending_refunds` row with `reason='capacity_full'`.

**Out of scope in PR 1:** real outbound Glofox; real PushPress API in tests; Slack delivery.

**Fixture generation:** one-off `deno eval`:
```typescript
const body = { event:"reservation.created", created:1715443200, data:{id:"uuid-a", reservedId:"uuid-b", customerId:"uuid-c", companyId:"uuid-d", registrationTimestamp:1715443100} };
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(body.data)));
console.log(Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,"0")).join(""));
```

---

## 9. Build sequence

1. `_shared/types.ts`
2. `_shared/signature.ts` + `tests/signature.test.ts` + fixtures
3. `_shared/dedup.ts` + `tests/dedup.test.ts`
4. `_shared/filter.ts` + `tests/filter.test.ts`
5. `supabase/migrations/0002_filtered_status.sql` (apply locally)
6. `_shared/event-log.ts`
7. `_shared/glofox-client.ts` (unit-tested with stubbed fetch)
8. `_shared/pushpress-client.ts` (unit-tested with stubbed fetch)
9. `_shared/mappings.ts` (unit-tested with mocked clients + supabase)
10. `handlers/reservation-created.ts` (unit-tested with full mocks)
11. `index.ts` rewrite + `tests/integration.test.ts`
12. `scripts/setup-webhook.ts` (manual smoke only)
13. `.env.example` update

---

## 10. Tradeoffs and decisions

| Decision | Rejected alternative | Why |
|---|---|---|
| Hand-roll signature verify | Use SDK's `validateWebhook` | Alpha SDK + esm.sh on Deno cold-start = unknown failure mode; 500s on every webhook. 20 lines of `crypto.subtle` is cheap. |
| Env var allowlist | DB table | Small list, infrequent change. Deploy = audit. DB adds query per request + migration lifecycle for no benefit. |
| Filter in handler | Filter in dispatcher | `classTypeName` requires `getClass()` which is also needed for slot resolution. Co-locate. |
| `'filtered'` distinct from `'skipped'` | Reuse `'skipped'` | Ops needs to distinguish "correctly suppressed CF" from "unknown event name". |
| Single INSERT idempotency | Two-phase write | No guarantee Edge Function survives long enough. Stuck-pending row is an ops signal. |
| Lazy slot mapping | Pre-sync nightly | Pre-sync adds cron + delta + deletion. Lazy is one DB read + one Glofox query, amortized to zero. |
| No retry in PR 1 | Outbound retry | Glofox reliable at this volume. Add when failure pattern justifies. PR 2 decision. |

---

Ready for implementation? **Y** — with one pre-condition: TSG ops must provide the sauna `classTypeName` values to populate `SAUNA_CLASS_TYPE_ALLOWLIST`. All code can be written and unit-tested without this value; integration test will produce `handler_status='filtered'` for every reservation until the env var is set, which is the correct safe default.
