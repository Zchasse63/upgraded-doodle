# PR 1 — first vertical slice

> **Purpose**: ship a single end-to-end working webhook path. The chosen path is `reservation.created` because it exercises every cross-cutting concern (signature verification, idempotency, member resolution, slot mapping, Glofox booking, overbooking detection). Everything else is built on top of what PR 1 lands.

## Prerequisite: unblock Q1

PR 1 cannot ship without resolving [`open-questions.md` Q1](open-questions.md) — the Glofox externally-billed `payment_method` value. The `reservation.created` path doesn't directly call the membership-assign endpoint, BUT in order to test it end-to-end we need a real Glofox membership assigned to a test user. So Q1 needs an answer before the test setup works.

Steps:
1. Read Glofox OpenAPI 2.2 spec for `MembershipPurchaseRequest.payment_method`.
2. Test each candidate value (`complimentary`, `external`, custom payment type) in Glofox sandbox.
3. Pick the working value.
4. Document in [`docs/glofox/api-surface.md`](glofox/api-surface.md) and update `plan_mappings.payment_method` notes.

## Goals

By the end of PR 1:

- A signed PushPress `reservation.created` webhook, sent to the deployed Edge Function, results in a Glofox booking for the matching user/event.
- Duplicate deliveries don't double-book.
- Invalid signatures are rejected with 401.
- Capacity-full reservations land in `pending_refunds`.
- `event_log` records every event with full payload + outcome.
- A one-shot script can subscribe / rotate the PushPress webhook.

## Out of scope for PR 1

- The other 8 event handlers (enrollment.*, reservation.canceled, reservation.waitlisted, checkin.*, class.canceled, customer.details.changed) — those are PR 2.
- Admin UI / operator queue view — PR 3+.
- Slack notifications for overbookings — wire later when we have a webhook URL.
- Debouncing for `customer.details.changed` — PR 2 stub, refine later.
- Multi-tenant / multi-company support — never (single PushPress company per deployment).

## File-by-file scope

### `supabase/functions/_shared/signature.ts` — NEW

Pure-function HMAC-SHA256 verification mirroring the SDK's `webhook-security-custom.ts`.

```typescript
export async function verifyPushPressSignature(
  parsedBody: { data: unknown; [k: string]: unknown },
  providedSignature: string,
  signingSecret: string,
): Promise<boolean>
```

- Uses `crypto.subtle.importKey` + `crypto.subtle.sign("HMAC", ...)` with `SHA-256`.
- Message is `JSON.stringify(parsedBody.data)` — NOT the raw HTTP body.
- Output: lowercase hex compared with `providedSignature`. Use `crypto.timingSafeEqual` if available in Deno; otherwise constant-time compare manually.
- Returns `false` on any error (missing sig, malformed key, etc.). Never throws to the caller.

**Acceptance**: unit test against the SDK's own `validateWebhook` output (paste a recorded payload + signature pair into `tests/fixtures/`, assert our function returns `true`).

### `supabase/functions/_shared/dedup.ts` — NEW

```typescript
export async function computeDedupKey(body: PushPressWebhookBody): Promise<string>
```

SHA-256 of `${event}|${data.id ?? ""}|${data.companyId ?? ""}|${created}`. Returns lowercase hex.

### `supabase/functions/_shared/event-log.ts` — NEW

```typescript
export async function recordEvent(supabase, args: {
  dedupKey: string;
  event: string;
  companyId?: string;
  signatureVerified: boolean;
  handlerStatus: "pending" | "success" | "failed" | "skipped" | "duplicate";
  handlerError?: string;
  durationMs?: number;
  payload: unknown;
  glofoxResponse?: unknown;
}): Promise<{ duplicate: boolean }>
```

Inserts into `event_log`. On unique-violation (`dedup_key` collision), returns `{ duplicate: true }` and does not raise. On any other error, throws.

### `supabase/functions/_shared/glofox-client.ts` — NEW

Minimal port of Meridian's `lib/glofox/client.ts`. PR 1 only needs:

- `GET /2.0/events?date_from=...&date_to=...` (slot resolution)
- `POST /2.3/branches/{branchId}/bookings` (create booking)
- `POST /v3.0/namespaces/members/retrieve` (member lookup)
- `POST /2.1/branches/{branchId}/leads` (lead create fallback)

3-header auth, rate-limit pacing (start at 200ms between requests for safety; tune later), `success: false` checking. Throws `GlofoxApiError` on failure.

### `supabase/functions/_shared/mappings.ts` — NEW

```typescript
export async function getOrCreateMemberLink(supabase, glofox, pushpressCustomerId, email): Promise<MemberLink>
export async function getOrResolveSlotMapping(supabase, glofox, pushpressCalendarItemId, classStart): Promise<SlotMapping>
export async function enqueuePendingRefund(supabase, args: { ... }): Promise<void>
```

Pure read/write helpers. No business logic — handlers orchestrate.

### `supabase/functions/pushpress-webhook/index.ts` — UPDATE

Replace TODOs in `verifySignature`, `dedupKey`, and `handleReservationCreated`. Leave the other 8 handlers as `return { status: "skipped" }` (they go to PR 2). Wire the dispatcher to:

1. Read body, parse JSON.
2. Verify signature → 401 on fail.
3. Compute dedup key.
4. Insert event_log row with `handler_status='pending'`.
5. If duplicate: mark `handler_status='duplicate'`, return 200 OK.
6. Else: dispatch to handler, capture result.
7. UPDATE event_log row with handler status, duration, glofox_response.
8. Return 200 OK.

### `scripts/setup-webhook.ts` — NEW

One-shot script (run with `deno run --allow-net --allow-env scripts/setup-webhook.ts`). Calls PushPress `manageWebhooks.create` with the Edge Function URL and the 9 event types we subscribe to. Prints the `signingSecret` to stdout. Reads `PUSHPRESS_API_KEY` and `PUSHPRESS_COMPANY_ID` from env.

Operator runs this once, copies the secret to `.env.local`, then `supabase secrets set PUSHPRESS_WEBHOOK_SIGNING_SECRET=...`.

### `tests/` — NEW

Minimum viable tests for PR 1:

```
tests/
├── fixtures/
│   ├── reservation.created.valid.json    — recorded webhook body
│   ├── reservation.created.signature.txt — its valid signature
│   └── reservation.created.tampered.json — body with one field changed
├── signature.test.ts                    — unit tests for verifyPushPressSignature
├── dedup.test.ts                        — unit tests for computeDedupKey
└── integration.test.ts                  — fire a signed payload at the local
                                          function, assert event_log row and
                                          (mocked) Glofox call
```

Tests run via `deno test --allow-env --allow-net --allow-read`.

## Acceptance criteria

PR 1 lands when ALL of these pass:

- [ ] `deno test` passes (unit + integration)
- [ ] `supabase db reset` then `supabase db push` applies migrations cleanly
- [ ] `supabase functions serve pushpress-webhook --env-file .env.local` starts without errors
- [ ] `curl` the local function with the recorded fixture + matching signature → 200 OK, event_log row created, mocked Glofox call observed
- [ ] Same `curl` repeated → 200 OK with `handler_status='duplicate'` in event_log (no second Glofox call)
- [ ] `curl` with a tampered signature → 401, event_log row with `signature_verified=false`
- [ ] Q1 (Glofox `payment_method`) answered and documented
- [ ] Code-reviewer agent run on the diff with no critical findings
- [ ] `simplify` skill run on `index.ts` and handler code

## Pipeline reminder

Follow the CLAUDE.md pipeline strictly for PR 1:

1. **Architect** — `feature-dev:code-architect` agent on the PR 1 scope before writing any code
2. **Implement** — write the code following the blueprint
3. **Review** — `feature-dev:code-reviewer` agent; for webhook auth specifically, also `codebase-cartographer:security`
4. **Simplify** — `simplify` skill on handler + dispatcher to avoid copy-paste creep
5. **Verify** — the acceptance criteria above

The PR description should reference this doc and call out Q1's resolution.
