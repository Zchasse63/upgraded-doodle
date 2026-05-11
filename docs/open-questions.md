# Open questions

Living tracker of blockers and decisions that need resolution. Each item has a status and ownership pointer. **Q1 is the gating blocker for PR 1.**

Status legend: `OPEN` (no answer yet), `INVESTIGATING` (someone's looking), `ANSWERED` (resolved — move to bottom).

---

## Q1 — Glofox externally-billed `payment_method` value

**Status**: OPEN — **gating blocker for PR 1**

**Question**: what value goes in `MembershipPurchaseRequest.payment_method` so Glofox assigns a membership without attempting to charge the customer?

**Context**: CC handles billing in PushPress (on the member's existing card on file). When PushPress fires `enrollment.created`, we POST to `/2.2/branches/.../memberships/.../plans/.../purchase` in Glofox to mirror the assignment. Glofox must NOT attempt to charge — there's no card on file.

**Candidate values to test (in sandbox)**:
- `complimentary`
- `external`
- `cash` (might still record a transaction; unclear)
- A custom staff-only payment type configured in the Glofox dashboard (need to check if TSG has one)
- A combination with `promo_code` set to a 100%-off promo

**How to resolve**:
1. Get the Glofox OpenAPI 2.2 spec — see if `payment_method` has an enum.
2. Test each candidate in sandbox against a test user with a known membership.
3. Confirm the assignment succeeded AND no charge attempt was made (check Glofox transactions afterward).
4. Update `plan_mappings.payment_method` documentation in [`api-surface.md`](glofox/api-surface.md) once known.

**Owner**: next implementation session, as first PR 1 task.

---

## Q2 — PushPress webhook retry policy

**Status**: OPEN

**Question**: what does PushPress do when our webhook endpoint returns 5xx, times out, or simply fails to respond? Max retries? Backoff schedule? Dead-letter behavior? Idempotency keys?

**Context**: undocumented in the SDK or any public PushPress page. Our idempotency design (dedup_key in `event_log`) assumes retries are possible. If we learn retries don't happen, we can simplify; if we learn they happen aggressively, we might need more careful backpressure.

**How to resolve**: ask PushPress support directly (support email or developer Slack if they have one). Until answered, assume aggressive retries.

**Owner**: ops / user to email PushPress.

---

## Q3 — PushPress API rate limits

**Status**: OPEN — low priority

**Question**: what are the actual rate-limit values on the PushPress REST API? The SDK defines a `RateLimited` (HTTP 429) error for 8 of 49 operations, but the limit values are not exposed.

**Context**: our outbound API calls to PushPress are minimal (only `customers.get`, `classes.get`, and `messages.push.send` for overbook alerts). Unlikely to hit limits at our volume.

**How to resolve**: ask PushPress support.

**Owner**: ops / user.

---

## Q4 — Glofox booking endpoint behavior on capacity full

**Status**: OPEN — must verify before going live

**Question**: when a Glofox class is at capacity, does `POST /2.3/branches/{branchId}/bookings` return a clean 4xx error with a parseable body, or does it silently 200 OK with `success: false`, or something else?

**Context**: our overbooking detection logic depends entirely on this. If Glofox 200s when full, we'd silently overbook — every CC reservation that lands when the slot is physically full would be a bug.

**How to resolve**:
1. Set up a known-full Glofox class in sandbox (manually book 12 test users).
2. Try to book a 13th.
3. Record the exact response status + body.
4. Update the `handleReservationCreated` handler design accordingly.

**Owner**: next implementation session, before reservations handler ships.

**Related**: also verify whether the same endpoint supports a `waitlist` flag, or if waitlists need a different endpoint.

---

## Q5 — Sauna add-on memberships configured in Glofox

**Status**: OPEN — operational, not code

**Question**: have the Glofox memberships that mirror PushPress's Sauna add-on plans been created in the Glofox dashboard? If not, what are the exact name + billing variants?

**Context**: `plan_mappings` needs the Glofox `membership_id` + `plan_code` for each variant. CC's plans (from the original handoff doc) are:
- Recurring monthly unlimited Sauna add-on
- Recurring 4-pack (credit-based) Sauna add-on

These need matching Glofox memberships. Glofox doesn't have a separate "credit pack" write API, so the 4-pack is modeled as a credit-based membership.

**How to resolve**: TSG / CC ops configures the memberships in Glofox dashboard, then provides the IDs/codes for `plan_mappings`.

**Owner**: TSG ops.

---

## Q6 — Webhook subscription setup

**Status**: OPEN

**Question**: when do we create the PushPress webhook subscription, and where do we durably store the returned `signingSecret`?

**Context**: `POST /webhooks` returns the secret exactly once. After that, only rotation is possible. The Edge Function needs the secret as `PUSHPRESS_WEBHOOK_SIGNING_SECRET`.

**Proposed approach**:
1. After the Edge Function is deployed to a public URL, run a one-shot script (in `scripts/setup-webhook.ts`, not yet written) that calls `manageWebhooks.create`.
2. Print the `signingSecret` once, save to `.env.local`, save to `supabase secrets set PUSHPRESS_WEBHOOK_SIGNING_SECRET=...`.
3. Never store the secret in version control or in `event_log`.
4. Rotation procedure documented separately (PR 3+).

**Owner**: next implementation session — write the one-shot script as part of PR 1.

---

## Q7 — Other sauna slot types

**Status**: OPEN — low priority

**Question**: are there sauna slot variants we need to handle (different durations, different events like "Cold Plunge Only" vs "Full Contrast", staff-led vs self-serve), or just one standard sauna slot type?

**Context**: affects how generic the slot mapping logic needs to be. If everything is one standard 50-minute sauna class, we can hardcode the class type filter. If there are multiple variants, we need a more general filter.

**How to resolve**: ask TSG ops; review the published PushPress class schedule once CC publishes it.

**Owner**: TSG ops / next implementation session to confirm before writing the slot resolver.

---

## Q8 — Capacity tuning data collection

**Status**: OPEN — operational, post-launch

**Question**: after 2 weeks live, what data do we want to collect from `pending_refunds` (and Glofox booking history) to tune the 6/6 CC/TSG capacity split?

**Context**: the 6 CC / 6 standalone TSG split is a v1 baseline pulled from an internal conversation, not data. Tuning happens by adjusting the PushPress class capacity vs. Glofox class capacity — no code change.

**Proposed metrics**:
- Overbook count per slot per week (from `pending_refunds`)
- Empty seats per slot per week (slots that closed below capacity)
- Time-of-day patterns

**Owner**: post-launch retrospective.

---

## Answered (archive)

_None yet._
