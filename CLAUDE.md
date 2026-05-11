# tsg-cc-bridge — Claude Code instructions

One-way webhook middleware that mirrors PushPress events into Glofox. Built for The Sauna Guys (TSG) so that Cigar City CrossFit (CC) members buying a Sauna add-on in PushPress can have their activity reflected in TSG's existing Glofox-based analytics.

**This repo is a sibling of `~/Code/meridian-fresh/`** — Meridian is TSG's operator dashboard (Next.js + Supabase, separate). This is the integration glue between two third-party platforms.

## Stack

- **Runtime**: Supabase Edge Functions (Deno)
- **Database**: Supabase Postgres (a NEW project, schema-isolated from Meridian)
- **PushPress**: `@pushpress/pushpress@1.15.0` TypeScript SDK
- **Glofox**: REST client (port the read patterns from `~/Code/meridian-fresh/lib/glofox/`)
- **Language**: TypeScript on Deno

## Architecture (one-paragraph version)

PushPress sends webhooks (HMAC-SHA256 signed over `JSON.stringify(body.data)`) to our single Edge Function entry point at `POST /functions/v1/pushpress-webhook`. The function verifies the signature using `pushPress.validateWebhook()`, looks up the event handler by event name, performs idempotency check against the `event_log` table (PushPress doesn't expose retry policy, so we must be safe under retries), executes the handler, records the outcome. Handlers call into Glofox via a small REST client. Mapping tables (`plan_mappings`, `slot_mappings`, `members_link`) translate PushPress IDs to Glofox IDs. Capacity overruns and unmappable events surface to an `pending_refunds` queue or ops alert.

See [`docs/architecture.md`](docs/architecture.md) for the full version.

## Pipeline (non-negotiable — same contract as Meridian)

Every change touching `supabase/`, schema, or webhook handlers must follow:

1. **Architect** — `feature-dev:code-architect` agent for any change spanning >3 files, schema changes, new event handler, new Glofox endpoint integration.
2. **Implement** — write the actual code following the blueprint.
3. **Review** — `feature-dev:code-reviewer` agent on the diff. Fix high-priority findings before moving on. For anything touching webhook auth, idempotency, or RLS, additionally run `codebase-cartographer:security`.
4. **Simplify** — for handler code, run the `simplify` skill to keep things modular and avoid copy-paste creep.
5. **Verify** — `supabase functions serve`, hit the function with a signed payload (or a recorded one from PushPress's test webhook UI), confirm the expected Glofox call fires (or stub it and assert), confirm the `event_log` row is recorded.

For trivial changes (single-file, <10 lines, obvious fix), abbreviate to **Implement + Verify**.

## Key files

| Path | Purpose |
|---|---|
| `supabase/functions/pushpress-webhook/index.ts` | Single entry point for all PushPress webhooks. Dispatch by `event` name. |
| `supabase/functions/_shared/` | Glofox REST client (port from Meridian), PushPress types, shared utilities. |
| `supabase/migrations/0001_initial.sql` | Mapping + audit tables: `plan_mappings`, `slot_mappings`, `event_log`, `pending_refunds`, `members_link`. |
| `docs/architecture.md` | System design. |
| `docs/handoff-from-meridian.md` | Pre-existing context from the planning session. |
| `docs/pushpress/sdk-reference.md` | Full reference for `@pushpress/pushpress@1.15.0`. Authoritative. |
| `docs/glofox/api-surface.md` | Every Glofox endpoint we call, with auth headers and quirks. |
| `docs/open-questions.md` | Live blocker list — read before starting work. |
| `docs/pr-1-plan.md` | PR 1 scope. |

## Patterns & conventions

- **One Edge Function**, dispatch by event name internally. Webhook providers prefer a single URL — don't split into one function per event.
- **Verify signature before doing anything.** Always. PushPress's signature is HMAC-SHA256 over `JSON.stringify(body.data)` with the `webhook-signature` header. Use the SDK's `validateWebhook` helper or mirror its math exactly (see `docs/pushpress/sdk-reference.md` § Webhooks).
- **Idempotency by event ID + content hash.** PushPress webhook payloads don't include a stable event ID, so use a SHA-256 of `{event, data.id, data.companyId, created}` as the dedup key. Store in `event_log`.
- **Lazy slot mapping.** First time a PushPress class slot is referenced, look it up against `GET /2.0/events?date_from=...&date_to=...` in Glofox and cache in `slot_mappings`. Don't pre-sync the schedule.
- **Externally-billed memberships.** Glofox must not attempt to charge — CC handles billing on its end. The exact `payment_method` value to pass is an open question; see `docs/open-questions.md` § Q1.
- **Type everything via Zod.** Use the SDK's exported schemas where they exist; write our own for Glofox responses (Glofox has no published schema).
- **No `console.log` in committed code.** Use a structured logger (`console.error` for errors with stack traces; structured key-value JSON for ops events).
- **`Deno.env.get()` not `process.env`.** This is Deno, not Node.
- **Test data lives in `tests/fixtures/`** (when we add tests). Real webhook payloads from PushPress's dashboard go there, redacted.

## Gotchas (will burn you)

- **iCloud-synced paths corrupt git.** Never put this repo under `~/Desktop` or `~/Documents`. Stay in `~/Code/`. Meridian lost 27 commits to iCloud eviction of git objects — see Meridian's CLAUDE.md for the full incident.
- **The PushPress webhook signature is non-standard.** It's HMAC of `JSON.stringify(body.data)`, NOT of the raw request body. If you re-implement verification, mirror the SDK exactly. See `docs/pushpress/sdk-reference.md` § Webhooks.
- **`signingSecret` is only returned at webhook-creation time.** Save it to `PUSHPRESS_WEBHOOK_SIGNING_SECRET` immediately; you can rotate but you cannot re-fetch.
- **Glofox returns 200 + `success: false`** when one of the three auth headers is missing. Always check the response body, not just the status code. See `docs/glofox/README.md` § Auth.
- **Reservations and check-ins are read-only via the PushPress API.** We get them via webhooks but can't write them back. That's intentional — the architecture is one-way for a reason.
- **`createCustomer` only creates leads.** Cannot create an active PushPress member via API. Member creation happens through PushPress's UI.
- **PushPress timestamp units mix Unix seconds, milliseconds, and `YYYY-MM-DD` strings** depending on the field. See `docs/pushpress/sdk-reference.md` § SDK quirks #6.

## Environment

Live creds in `.env.local` (NOT committed). See `.env.example` for the full list. The two systems' creds you'll most often touch:

- `PUSHPRESS_API_KEY` — the `sk_xxxx:yyyy` key from PushPress dashboard
- `PUSHPRESS_COMPANY_ID` — the company UUID
- `PUSHPRESS_WEBHOOK_SIGNING_SECRET` — returned at subscription creation
- `GLOFOX_API_KEY`, `GLOFOX_API_TOKEN`, `GLOFOX_BRANCH_ID` — Glofox 3-header auth

## Specialized agents/skills already wired

| Need | Agent / Skill |
|---|---|
| Architecture design | `feature-dev:code-architect` |
| Guided multi-step feature dev | `feature-dev:feature-dev` skill |
| Code review on a diff | `feature-dev:code-reviewer` |
| Codebase exploration (3+ queries) | `Explore` or `feature-dev:code-explorer` |
| Multi-step planning | `Plan` |
| Complex debugging / RCA | `deep-reasoning` skill |
| Technical feasibility check | `scrutinize:scrutinize-technical` |
| Full plan scrutiny | `scrutinize:scrutinize` |
| Codebase audit | `codebase-cartographer:audit` |
| Security review | `codebase-cartographer:security` |
| Edge Functions deployment | `netlify` skill is not relevant here — use Supabase CLI |

## Cross-project context

When you need details about TSG's Glofox usage, read from `~/Code/meridian-fresh/lib/glofox/` and `~/Code/meridian-fresh/CLAUDE.md`. The Glofox client patterns (3-header auth, `/Analytics/report` POST for transactions, rate limit pacing at 120ms between pages) are battle-tested there — port, don't re-invent.

Do NOT modify Meridian from here. Cross-reference only.

## Current state

Phase: **pre-PR-1**. Repo bootstrapped with docs + schema + scaffold. No business logic yet. Open blockers in [`docs/open-questions.md`](docs/open-questions.md) — Q1 (Glofox externally-billed payment method) is the gating question.
