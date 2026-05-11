# Handoff from the Meridian planning session

> **Purpose**: preserve context from the session that produced this repo. The implementation work happens in a NEW Claude Code session started from this directory. That session won't have the conversation history that produced these decisions — this doc is the bridge.

## What happened

A planning session ran in [`~/Code/meridian-fresh/`](https://github.com/Zchaste63/meridian-fresh) (TSG's operator dashboard). The PushPress-side architecture team had sent over a long handoff document describing a middleware they wanted to build for the CC↔TSG integration. The TSG planning session reviewed that handoff, raised three architectural concerns, agreed on a path forward, and produced this repo.

## Decisions made in the planning session

### 1. TSG-owned PushPress account is sandbox-only

> Original interpretation question: was TSG creating a PushPress account because (A) it's a sandbox for safe development before touching CC's real PushPress, or (B) TSG was also moving toward using PushPress for its own member-facing flows?

**Answer: (A) — sandbox only.** TSG continues to use Glofox as its system of record. The free PushPress account exists so we can develop and test the bridge without risking CC's production setup. When PR 1+ are stable, we'll swap the `PUSHPRESS_API_KEY` and `PUSHPRESS_COMPANY_ID` env values for CC's credentials.

### 2. Middleware lives in its own repo, not in Meridian

The Supabase Edge Functions and supporting schema live in this repo (`tsg-cc-bridge`) — separate from Meridian. Reasons:

- Clean isolation: middleware is integration glue between two third-party systems; it doesn't share a domain with Meridian's analytics/dashboard surface.
- Different Supabase project: avoids polluting Meridian's schema with mapping/audit tables that have nothing to do with TSG's operator workflow.
- Separate deployment lifecycle: the bridge can iterate without re-deploying Meridian.

Cross-reference is encouraged: this repo reads Meridian's Glofox client patterns at [`~/Code/meridian-fresh/lib/glofox/`](../../meridian-fresh/lib/glofox) and CLAUDE.md as background knowledge, but does NOT import code from there.

### 3. Repo location: `~/Code/`, NOT `~/Desktop/`

Meridian's CLAUDE.md documents an incident where iCloud-synced paths (`~/Desktop`, `~/Documents`) evicted git objects, deadlocking `git pack-objects` and ultimately costing 27 commits of history. This repo stays under `~/Code/` for the same reason.

### 4. Documentation strategy

PushPress's public docs URL 404s. The previous session noted that and extracted information from the SDK source by hand. We went further: a dedicated research agent surfaced a full structured reference at [`docs/pushpress/sdk-reference.md`](pushpress/sdk-reference.md) by reading the npm package source, the Speakeasy-generated type definitions, and the inline docstrings. The reference includes:

- Auth scheme details (header name, key shape)
- All 49 SDK operations with HTTP verbs and paths
- Every webhook event with its `data` payload shape
- The custom HMAC-SHA256 signature scheme over `JSON.stringify(body.data)` (non-standard, important to mirror exactly)
- 19 documented quirks and gotchas

Treat that reference as authoritative for the SDK's behavior.

## Concerns raised in planning that this repo addresses

### Concern A: the §5 "this pattern is already solved" assumption was wrong

The original handoff doc from the PushPress side said:

> "We're not going to have any of the user's credit card information... we just need to assign them credits essentially. It's essentially the same thing we're doing when we create a user in Glofox anyways."
>
> So this pattern is already solved in TSG's existing code — your session has likely written or is about to write it.

Reality: Meridian's `lib/glofox/sync-engine.ts` is **read-only** for memberships. It pulls staff, members, programs, classes, bookings, transactions, leads — none of those are writes. **There is no battle-tested `payment_method` value to hand the PushPress side.** This is now [open question Q1](open-questions.md) and is the gating blocker for PR 1.

### Concern B: lazy slot mapping has a race condition

If two PushPress reservations arrive simultaneously for the same slot before `slot_mappings` is populated, both will attempt the lookup → cache write. Resolution: rely on the `unique` constraint on `slot_mappings.pushpress_calendar_item_id` to deduplicate (`ON CONFLICT DO NOTHING`). If two concurrent reservations both successfully book before the row is cached, that's fine — the cache write happens after the booking succeeds. Worst case: one extra `GET /2.0/events` call.

### Concern C: capacity numbers (6/6 split) are arbitrary

The 6 CC / 6 TSG split is a v1 baseline pulled from a Slack conversation, not data. After 2 weeks live we should review actual overbooking events in `pending_refunds` and re-tune the split slot-by-slot. The split is editable in PushPress / Glofox dashboards — no code change required.

## Things the planning session DID NOT resolve

These are tracked in [`open-questions.md`](open-questions.md):

| ID | Question |
|---|---|
| Q1 | What `payment_method` value (or other API trick) does Glofox accept for an externally-billed membership assign? |
| Q2 | What is PushPress's webhook retry policy? (Not documented anywhere surfaced.) |
| Q3 | What are PushPress's API rate limits? (Not documented in the SDK.) |
| Q4 | Does Glofox's booking endpoint return a clean 4xx when capacity is full, with a parseable error? |
| Q5 | The Sauna add-on memberships (`recurring monthly unlimited` and `recurring 4-pack credit-based`) need to be configured in Glofox before we can populate `plan_mappings`. Status TBD. |
| Q6 | Webhook subscription setup — when is the PushPress subscription created, and where do we store the returned `signingSecret`? Out-of-band step? |
| Q7 | Are there other sauna slot types (different durations, different events) we need to handle, or just the one standard slot? |

## Source documents from the planning session

The original handoff document (verbatim, from the PushPress-side session):

> See [`docs/handoff-from-pushpress-side.md`](handoff-from-pushpress-side.md) — the original spec is preserved there for archive reference. Architecture decisions in this repo supersede it where they conflict.

Wait — that file doesn't exist yet. Note for next session: if the original PushPress-side handoff document is needed for reference, it lives in the planning session's conversation history. The most important pieces (Glofox endpoints we'll call, capacity numbers, event mapping) are now captured in [`architecture.md`](architecture.md) and [`pr-1-plan.md`](pr-1-plan.md).

## Cross-references to Meridian

The next session will need to consult Meridian for Glofox specifics. The key files:

| Meridian file | What's in it for us |
|---|---|
| `~/Code/meridian-fresh/CLAUDE.md` | Glofox 3-header auth, rate limits (10 RPS live, 3 RPS sandbox, burst 1000/300s), the 200+`success:false` quirk, the `/Analytics/report` POST shape for transactions, `start`/`end` are STRING unix-seconds |
| `~/Code/meridian-fresh/lib/glofox/client.ts` | Reference implementation of the REST client; port to Deno-flavored TS |
| `~/Code/meridian-fresh/lib/glofox/transformers.ts` | Glofox shape → Meridian shape; helpful for understanding the response payloads we'll receive |
| `~/Code/meridian-fresh/lib/glofox/sync-engine.ts` | The read-only sync engine. Confirms my note above that there's no existing membership-purchase code path |

**Do NOT modify Meridian from this repo.** Cross-reference only.

## What the next session should do first

1. Read this doc and [`architecture.md`](architecture.md) end-to-end.
2. Read [`open-questions.md`](open-questions.md). Q1 is the gating blocker.
3. Decide how to unblock Q1 — most likely by reading Glofox's OpenAPI spec for the `MembershipPurchaseRequest.payment_method` field, then sandbox-testing each candidate value against a test customer.
4. Then start PR 1 per [`pr-1-plan.md`](pr-1-plan.md), following the architect → implement → review → simplify → verify pipeline in [`CLAUDE.md`](../CLAUDE.md).
