# Open questions

Living tracker of blockers and decisions that need resolution. Each item has a status and ownership pointer. **Q1 is the gating blocker for PR 1.**

Status legend: `OPEN` (no answer yet), `INVESTIGATING` (someone's looking), `ANSWERED` (resolved — move to bottom).

---

## State change — 2026-05-11

### Test/sandbox topology (current)

The bridge is being developed and tested against **TSG's PushPress sandbox** (company `client_ddd1caa8be7225`, "The Sauna Guys"). TSG ops replicated CC's CrossFit schedule + memberships AND TSG's sauna schedule + memberships into this sandbox to simulate the eventual production state. **CC's real PushPress is OFF LIMITS until everything is stable in the sandbox.**

### Eventual production topology (cutover, later)

Once the bridge is stable, it will be re-pointed at CC's real PushPress. At that point, TSG members will still live in Glofox, and CC members with the sauna add-on will appear in CC's PushPress (with the bridge mirroring their sauna activity to Glofox).

### Three populations

| Member type | Lives in | Books sauna via | Bridge involvement |
|---|---|---|---|
| TSG-only (joined Sauna Guys directly) | Glofox only | Glofox | None — bridge ignores them |
| CC CrossFit member (no sauna add-on) | PushPress only | n/a — doesn't use sauna | Bridge ignores their CF activity |
| CC CrossFit member with sauna add-on | PushPress (primary) + Glofox (mirrored) | PushPress | **This is what the bridge handles** |

### Implications

- The bridge receives PushPress webhooks for **everything** in the sandbox: CrossFit enrollments, CrossFit reservations, CrossFit check-ins, sauna enrollments, sauna reservations, sauna check-ins. We must filter to mirror only the sauna-related events to Glofox — see **Q9**.
- **Glofox does NOT have a sandbox layer in our setup.** TSG's Glofox is the live operator system. Even during PushPress-sandbox testing, real Glofox writes are gated on explicit user approval. Tests use mocked `fetch`.
- Q5 is partially answered on the PushPress side (sauna plans configured in the sandbox); the Glofox side (matching `membership_id` + `plan_code` for each plan) still needs enumeration.

---

## Q1 — Glofox externally-billed `payment_method` value

**Status**: INVESTIGATING — **gating blocker for PR 1**

**Question**: what value goes in `MembershipPurchaseRequest.payment_method` so Glofox assigns a membership without attempting to charge the customer?

**Context**: CC handles billing in PushPress (on the member's existing card on file). When PushPress fires `enrollment.created`, we POST to `/2.2/branches/.../memberships/.../plans/.../purchase` in Glofox to mirror the assignment. Glofox must NOT attempt to charge — there's no card on file.

**Canonical Glofox payment-method IDs** (from the `/Analytics/report` `PaymentsReportRequest.filter.PaymentMethods[].id` schema in the Glofox API guide):

- `cash`
- `credit_card`
- `bank_transfer`
- `paypal`
- `direct_debit`
- `complimentary` ← **strongest candidate** (canonical "no-charge" type)
- `wallet`

`external` is NOT in the canonical list — that was a guess in earlier notes; drop it.

**Why `complimentary` is the strongest candidate**: it's the Glofox-native term for transactions where no money changes hands. Used internally for comped memberships assigned by staff. The purchase endpoint should accept it without triggering a charge flow.

**Backup**: a custom `staff_only: true` payment method configured in TSG's Glofox dashboard. The endpoint `GET /2.1/branches/{branchId}/payment-methods` returns every configured method for the branch with a `staff_only` flag — use this to enumerate what TSG actually has before testing. See [`api-surface.md`](glofox/api-surface.md) § Payment methods.

**Discarded**: `external` (not canonical), `promo_code` with 100%-off (overly complicated, and the plan-purchase endpoint already supports `promo_code: null` alongside `payment_method` so they're orthogonal).

**How to resolve**:
1. Call `GET /2.1/branches/{branchId}/payment-methods` against TSG's branch (read-only, safe with existing creds). Capture the list + flag any `staff_only: true` entries.
2. Test `payment_method: "complimentary"` against the purchase endpoint with a sandbox user + a known plan/membership pairing.
3. Confirm the assignment succeeded (user's `embedded membership` reflects the new plan) AND no charge attempt was recorded (check `/Analytics/report` filtered to the test user immediately after).
4. If `complimentary` fails or records a charge, fall through to the next `staff_only: true` method from step 1.
5. Document the winning value in [`api-surface.md`](glofox/api-surface.md) § Memberships and update `plan_mappings.payment_method` notes in [`../supabase/migrations/0001_initial.sql`](../supabase/migrations/0001_initial.sql).

**Owner**: next implementation session, as first PR 1 task.

**Source**: Glofox API guide at `/Users/zach/Desktop/literal-fishstick/glofox-api-guide.md` (last verified against `https://apidocs-plat.aws.glofox.com/openapi.yaml` on 2026-04-05).

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

## Q5 — Glofox memberships matching the unified PushPress plans

**Status**: INVESTIGATING — PushPress side complete (2026-05-11), Glofox side pending

**Question**: for each PushPress sauna plan that now lives in the unified PushPress space, what is the matching Glofox `membership_id` + `plan_code` that we POST to in `/2.2/.../purchase`?

**Context**: PushPress now holds all memberships (both CrossFit and Sauna). The bridge mirrors sauna-related ones only (see [Q9](#q9--filtering-sauna-events-out-of-the-unified-pushpress-feed)). Each PushPress sauna plan needs a row in `plan_mappings` with:
- `pushpress_plan_id` — UUID from PushPress
- `glofox_membership_id` — Mongo ObjectID from Glofox
- `glofox_plan_code` — string from Glofox
- `payment_method` — value from [Q1](#q1--glofox-externally-billed-payment_method-value)

**How to resolve**:
1. Get the list of sauna plan IDs from PushPress (`GET /plans/{id}` per plan, or extract from `customers` / `enrollments` data).
2. Get the list of Glofox memberships (`GET /2.0/memberships`).
3. Build a one-time mapping spreadsheet, seed `plan_mappings` via SQL migration.

**Owner**: TSG ops to confirm the PushPress plan IDs; implementation session to fetch the Glofox membership IDs and seed the table.

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

**Status**: OPEN — folded into Q9

**Question**: are there sauna slot variants we need to handle (different durations, different events like "Cold Plunge Only" vs "Full Contrast", staff-led vs self-serve), or just one standard sauna slot type?

**Context**: now that the PushPress schedule is unified, this question is subsumed by Q9 (filtering sauna events). Whatever scheme we use to distinguish sauna from CrossFit will also enumerate the sauna variants. Keep this entry as a pointer until Q9 is answered, then archive.

**Owner**: TSG ops / next implementation session — answer as part of Q9.

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

## Q9 — Filtering sauna events out of the unified PushPress feed

**Status**: OPEN — **new (2026-05-11), now a PR 1 concern**

**Question**: now that PushPress holds both the CrossFit and Sauna schedules + memberships in one space, how does the bridge identify which events belong to "sauna" and should mirror to Glofox? CrossFit events must be silently dropped.

**Context**: PushPress webhooks fire for every reservation, enrollment, check-in, etc. across the entire company. Mirroring everything would pollute Glofox with CF data and break TSG's existing sauna-only reports. We need a deterministic filter — a single source of truth for "is this a sauna event?" — applied at the dispatcher layer before any handler runs.

**Candidate filter strategies** (in rough order of preference):

1. **Class-type allowlist** — maintain a list of PushPress `classTypeName` values (or their underlying `typeId`s) that are "sauna" (e.g. `"Sauna - 50min"`, `"Cold Plunge"`, `"Contrast Therapy"`). Look up `Class.classTypeName` on each reservation / checkin and skip if not in the list. **Tradeoff**: needs maintenance whenever a new sauna class type is added in PushPress.

2. **Plan allowlist** — maintain a list of PushPress `plan_id`s that are sauna plans (recurring monthly, 4-pack, etc.). On enrollment events, check directly; on reservation events, resolve the customer's active enrollment first. **Tradeoff**: requires a lookup per event, and reservations don't carry the customer's plan directly. Possibly too indirect.

3. **Location-based** — if sauna classes happen at a separate PushPress `locationUuid`, filter on that. **Tradeoff**: assumes TSG ops actually configured a separate location. Need confirmation.

4. **Program/category** — if PushPress exposes a class category or program, filter on it. Unclear if it does for `Class.id` lookups; the SDK exposes a `class.type` discriminator but no program field.

**Recommendation for PR 1**: implement strategy 1 (class-type allowlist), seeded via a new column on the `slot_mappings` table or a new `event_filters` table. Start with a single string allowlist held in env / a small mapping table, refactor later if it grows.

**Action items for this session**:
1. Get the list of CrossFit class type names + sauna class type names from PushPress (operator can provide, or fetch via `pushPress.classes.type.list()`).
2. Add a filter step to the dispatcher in `pushpress-webhook/index.ts` before idempotency / handler dispatch.
3. Record filtered-out events to `event_log` with `handler_status='skipped'` and a reason — that way we have an audit trail of "no, we deliberately did not mirror this CF event".

**Owner**: this implementation session, as part of PR 1 architecture.

---

## Q10 — Replay staleness detection

**Status**: OPEN — deferred from PR 1 (security review flagged 2026-05-11)

**Question**: PushPress webhook headers don't include a `webhook-timestamp` field. Our `event_log.dedup_key` (which includes `created` in Unix seconds) gives functional replay protection — a captured signed payload, replayed days later, collides on insert and is silently `duplicate`-acked without re-running the handler. But we get no signal that a replay is happening.

**Recommendation from security review**: after a `23505` dedup collision, look up the original `event_log.received_at`. If `now() - received_at > 24 hours`, emit a structured-log warning so ops can see replay patterns.

**Why deferred**: not a correctness issue. The dedup mechanism does what it needs to. Staleness detection is an observability enhancement, not a fix.

**Owner**: PR 2 or later, optional.

---

## Q11 — Retention policy for `event_log.payload`

**Status**: OPEN — deferred from PR 1 (security review flagged 2026-05-11)

**Question**: `event_log.payload` stores the full webhook body as JSONB indefinitely. Each `reservation.created` payload contains `customerId` (a PushPress UUID — not PII on its own but it correlates to a real person who can be looked up via the API). What's the retention policy?

**Options**:
1. **Indefinite retention** — current. Useful for debugging, ops review, long-tail replay analysis. Storage cost grows linearly.
2. **TTL-based pruning** — scheduled job (pgcron or Supabase function on a schedule) sets `payload = NULL` after N days while keeping the audit metadata (`dedup_key`, `handler_status`, `received_at`).
3. **Field-level redaction** — store only `{event, data.id, data.companyId, created}` from the start, drop the full body.

**Recommendation**: Option 2 with N=90 days. Preserves debugging value while bounding the PII surface.

**Why deferred**: needs an ops decision (90 days is a guess, not policy). Doesn't affect correctness or PR 1 functionality.

**Owner**: TSG ops to set retention period; implementation session to write the prune job.

---

## Answered (archive)

_None yet._
