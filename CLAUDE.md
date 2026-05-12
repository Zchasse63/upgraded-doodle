# tsg-cc-bridge — Claude Code instructions

One-way webhook middleware that mirrors PushPress events into Glofox. Built for The Sauna Guys (TSG) so that Cigar City CrossFit (CC) members buying a Sauna add-on in PushPress can have their activity reflected in TSG's existing Glofox-based analytics.

**This repo is a sibling of `~/Code/meridian-fresh/`** — Meridian is TSG's operator dashboard (Next.js + Supabase, separate). This is the integration glue between two third-party platforms.

## Current state (2026-05-11)

**Live deployment**, single PushPress tenant: TSG's sandbox (`client_ddd1caa8be7225`). Awaiting cutover to CC's real PushPress.

- **9 of 9 webhook handlers shipped** (reservation.created, reservation.canceled, reservation.waitlisted, class.canceled, enrollment.created, enrollment.status.changed, enrollment.deleted, checkin.created, customer.details.changed)
- **2 Edge Functions deployed**: `pushpress-webhook` + `reconcile-cron` (daily 6 AM UTC)
- **9 migrations applied** (initial schema, filtered_status, pin_search_path, plan_mappings_promo, plan_mappings_seed, enrollment_links, pending_refunds_class_cancel, event_log_retention, event_log_payload_gin)
- **74 unit tests** passing
- `GLOFOX_MODE=live` (real Glofox writes), `CRON_SECRET` set, `SLACK_OPS_WEBHOOK_URL` empty (alerts silent)

OpenAPI spec mined 2026-05-12 closed two prior open questions: Q12 (attendance uses `model: "bookings"` + booking_ids) and OQ-1 (waitlist field is `join_waiting_list`, not `status`).

Audit + plan: [`docs/audit-2026-05-11.md`](docs/audit-2026-05-11.md). PR architectures: [`docs/pr-1-architecture.md`](docs/pr-1-architecture.md), [`docs/pr-2-architecture.md`](docs/pr-2-architecture.md), [`docs/pr-3-architecture.md`](docs/pr-3-architecture.md). Live open questions: [`docs/open-questions.md`](docs/open-questions.md).

## Stack

- **Runtime**: Supabase Edge Functions (Deno)
- **Database**: Supabase Postgres (project `pygbvcqjpwfodmoqkhos`, schema-isolated from Meridian)
- **PushPress**: hand-rolled REST client at `_shared/pushpress-client.ts`. SDK is in `scripts/` only (alpha; dual-export resolution under Deno cold-start is an unknown risk we won't take in the function).
- **Glofox**: hand-rolled REST client at `_shared/glofox-client.ts` (3 modes: `mock` / `readonly` / `live`).
- **Language**: TypeScript on Deno.

## Architecture (one-paragraph version)

PushPress sends webhooks (HMAC-SHA256 signed over `JSON.stringify(body.data)`) to a single Edge Function entry point at `POST /functions/v1/pushpress-webhook`. The function verifies the signature, computes a dedup key (SHA-256 of `event|id|companyId|created`), inserts a `pending` row into `event_log` (unique constraint = idempotency gate), dispatches to the per-event handler, then updates the row with the outcome. Handlers call Glofox via `_shared/glofox-client.ts`. Mapping tables (`plan_mappings`, `slot_mappings`, `members_link`, `pushpress_enrollment_links`) translate PushPress IDs to Glofox IDs. Capacity overruns and unmappable events surface to `pending_refunds` for ops follow-up + Slack alerts (when configured). A separate `reconcile-cron` Edge Function runs daily to audit gaps and Slack-post a summary.

See [`docs/architecture.md`](docs/architecture.md) for the full design.

## Pipeline (non-negotiable)

Every change touching `supabase/`, schema, or webhook handlers must follow:

1. **Architect** — `feature-dev:code-architect` agent for any change spanning >3 files, schema changes, new event handler, or new Glofox endpoint.
2. **Implement** — write the actual code following the blueprint.
3. **Review** — `feature-dev:code-reviewer` agent on the diff. Fix high-priority findings. For changes touching webhook auth, idempotency, or RLS, additionally run `codebase-cartographer:security`.
4. **Simplify** — for handler code, run the `simplify` skill to keep things modular and avoid copy-paste creep.
5. **Verify** — `deno test --allow-env --allow-read tests/` (all 74 must pass), then deploy + smoke test.

For trivial changes (single-file, <10 lines, obvious fix), abbreviate to **Implement + Verify**.

## Deployment

**The Supabase CLI requires Docker, which is often inconvenient. The preferred path is via the Supabase MCP server:**

- `mcp__eb733721-baac-4044-8a02-c07b74969698__deploy_edge_function` — full file-tree deploy in one call
- `mcp__eb733721-baac-4044-8a02-c07b74969698__apply_migration` — apply DDL
- `mcp__eb733721-baac-4044-8a02-c07b74969698__list_migrations`, `list_edge_functions`, etc.

**Setting secrets** requires the Supabase Management API directly (no MCP wrapper). PAT lives in macOS keychain at `Servous Supabase PAT`:
```bash
TOKEN=$(security find-generic-password -s "Servous Supabase PAT" -w)
curl -X POST "https://api.supabase.com/v1/projects/pygbvcqjpwfodmoqkhos/secrets" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '[{"name":"FOO","value":"bar"}]'
```

**Deploy file-tree convention**: `pushpress-webhook/` and `_shared/` are sibling directories at the deploy root (no `supabase/functions/` prefix on `name` fields). See prior deploy commits or `mcp__...__get_edge_function` for the layout.

## Key files

| Path | Purpose |
|---|---|
| `supabase/functions/pushpress-webhook/index.ts` | Single entry point. Dispatch by `event` name. |
| `supabase/functions/pushpress-webhook/handlers/` | 9 handler files (one per subscribed event). |
| `supabase/functions/_shared/glofox-client.ts` | 3 client classes: `GlofoxClient`, `GlofoxReadOnlyClient`, `GlofoxMockClient`. Switch via `GLOFOX_MODE`. |
| `supabase/functions/_shared/pushpress-client.ts` | Hand-rolled REST: getCustomer, getClass, getPlan. |
| `supabase/functions/_shared/mappings.ts` | DB-backed helpers: members_link, slot_mappings, plan_mappings, enrollment_links, pending_refunds. |
| `supabase/functions/_shared/signature.ts` | HMAC-SHA256 verify with constant-time compare. |
| `supabase/functions/_shared/dedup.ts` | SHA-256 dedup_key generation. |
| `supabase/functions/_shared/event-log.ts` | Insert-pending + update-final pattern, 23505 dedup catch. |
| `supabase/functions/_shared/filter.ts` | Q9 sauna filter — class-type allowlist + plan-category allowlist. |
| `supabase/functions/_shared/slack.ts` | `alertOps(supabase, event, detail)` — throttled, no-op when URL unset. |
| `supabase/functions/reconcile-cron/index.ts` | Scheduled safety-net audit (daily). |
| `supabase/migrations/000{1..8}_*.sql` | Schema + retention pgcron. |
| `scripts/reconcile.ts` | Local audit + replay tool. `--mode reservations\|enrollments\|all`. |
| `scripts/setup-webhook.ts` | One-shot PushPress subscription. Captures `signingSecret` once. |
| `scripts/test-drive.ts` | In-process handler invocation for local dev. |
| `docs/architecture.md` | Full system design. |
| `docs/audit-2026-05-11.md` | What's built / remaining / plan to 100%. |
| `docs/open-questions.md` | **Live open questions — read first.** Q12 (attendance attribution), Q13 (membership lookup), OQ-1 (waitlist) currently OPEN. |
| `docs/glofox/api-surface.md` | Every Glofox endpoint we call, with verified shapes and quirks. |
| `docs/pushpress/sdk-reference.md` | Authoritative reference for the SDK. |

## Patterns & conventions

- **One Edge Function** for the webhook, dispatch by event name internally. Splitting per event makes ops harder.
- **Verify signature before doing anything.** HMAC-SHA256 over `JSON.stringify(body.data)`, NOT the raw HTTP body. See [`signature.ts`](supabase/functions/_shared/signature.ts).
- **Idempotency by content hash.** PushPress payloads don't include a stable event ID. Use `SHA-256({event, data.id, data.companyId, created})` in `event_log.dedup_key` with a unique constraint. On 23505: return 200, no handler re-run.
- **Lazy slot mapping.** First reservation for a calendar item → look up against `GET /2.0/events?start=...&end=...`. Cache in `slot_mappings`. Don't pre-sync the schedule.
- **GLOFOX_MODE switch.** `mock` (no network) / `readonly` (real GETs, writes throw) / `live` (full). All 3 clients implement `GlofoxClientShape`. Use in tests and Phase B verification.
- **Externally-billed memberships use payment_method='cash' + TESTCODE promo.** Q1 resolution (2026-05-11). See [`plan_mappings_seed`](supabase/migrations/0005_plan_mappings_seed.sql).
- **Single Edge Function INSERT-then-UPDATE pattern for event_log.** Insert `pending` first (catches dedup via unique violation), call handler, update with final status. Crashes mid-handler leave a stuck `pending` row — visible to ops.
- **Filter-first dispatch.** Handlers that mirror to Glofox check `isSaunaClassType` / `isSaunaPlanCategory` early; non-sauna events return `status:'filtered'` and never reach Glofox. Safe-default = empty allowlist filters everything.
- **No `console.log` in committed code.** Use `console.error(JSON.stringify({level,...}))` for structured ops events. Edge Functions pipe stderr to Supabase logs.
- **`Deno.env.get()` not `process.env`.** This is Deno.
- **No external dependencies** beyond `@supabase/supabase-js@2.45.0` (via esm.sh). No PushPress SDK in the function (alpha-labeled, dual-export resolution risk under Deno cold-start). No Zod yet — TypeScript interfaces only.
- **Test fixtures** live in `tests/fixtures/`. Real webhook payloads captured from PushPress's dashboard test feature, redacted.

## Glofox gotchas (will burn you)

These are the lessons we've paid for. Don't relearn them.

- **3 required headers**: `x-api-key`, `x-glofox-api-token`, `x-glofox-branch-id`. Missing any → `200 OK { success: false }`. The client's `request()` normalizes that to `GlofoxApiError(400)`.
- **Bookings vs attendances use DIFFERENT model shapes**:
  - `POST /2.3/.../bookings` → `model: "event"` (singular), `model_id: <id>`
  - `POST /2.0/attendances` → `model: "events"` (PLURAL), `model_ids: [<id>]` (ARRAY)
- **`POST /2.3/.../bookings`** silently accepts `status: "WAITING"` but creates a CONFIRMED booking. Real waitlist endpoint unknown — `reservation-waitlisted` handler gated behind `GLOFOX_WAITLIST_VERIFIED=true`.
- **`cancelBooking` 404 path is actually 400 + `BOOKING_NOT_FOUND`.** Glofox returns HTTP 400 with that error code for missing bookings (not 404). Both 404 and `400+BOOKING_NOT_FOUND` are treated as idempotent success.
- **`purchaseMembership` does NOT return `userMembershipId`.** Response is `{success, message, status, invoice_id}`. Cancel handlers degrade gracefully because there's no REST endpoint to list a user's memberships either — see Q13.
- **No "list user's memberships" endpoint exists.** Tried every plausible path. `/2.0/members/{id}?private=any` returns only the PRIMARY (PAYG) membership, not NOEQL assignments. Cancel = manual ops in dashboard until Glofox support gives us an answer.
- **`/2.0/events`** uses `start`/`end` params. The older `date_from`/`date_to` are silently ignored. Our slot resolver also validates returned `time_start` falls within the window as defense in depth.
- **`/2.0/memberships`** returns plan-level memberships only; pass `?private=any` to include NOEQL and other private/internal types.
- **Email lookup is case-sensitive.** Always `.toLowerCase()` before `POST /v3.0/namespaces/members/retrieve`.
- **Member ID inconsistency**: members `/retrieve` uses `id`, events/memberships use `_id`. Same data model, different field name per endpoint.
- **`/2.0/register`** requires the password to contain a digit (`PASSWORD_RULE_DIGIT`). Our `generatePlaceholderPassword` uses random hex which can theoretically (rarely) be digit-free.
- **$0 memberships not allowed.** Minimum $1. NOEQL is $1 + `TESTCODE` 100%-off promo = net $0.

## Other gotchas

- **iCloud-synced paths corrupt git.** Never put this repo under `~/Desktop` or `~/Documents`. Stay in `~/Code/`. Meridian lost 27 commits to iCloud eviction; full incident in Meridian's CLAUDE.md.
- **PushPress webhook signature is non-standard.** HMAC of `JSON.stringify(body.data)`, NOT the raw request body. Mirror our [`signature.ts`](supabase/functions/_shared/signature.ts).
- **`signingSecret` is only returned at webhook-creation.** Save to `PUSHPRESS_WEBHOOK_SIGNING_SECRET` immediately; rotate-only after.
- **Reservations + check-ins are read-only via PushPress API.** We receive them via webhooks but can't write back. One-way bridge by design.
- **`createCustomer` only creates leads in PushPress.** Active members are created via the PushPress UI.
- **PushPress timestamp units are mixed**: Unix seconds, milliseconds, and `YYYY-MM-DD` strings depending on the field. See [`docs/pushpress/sdk-reference.md`](docs/pushpress/sdk-reference.md) § SDK quirks #6.

## Environment

Live creds in `.env.local` (gitignored). See `.env.example` for the full list. The variables you'll most often touch:

| Variable | Purpose |
|---|---|
| `PUSHPRESS_API_KEY` | `sk_xxxx:yyyy` from PushPress dashboard |
| `PUSHPRESS_COMPANY_ID` | Company UUID |
| `PUSHPRESS_WEBHOOK_SIGNING_SECRET` | Returned at subscription creation |
| `GLOFOX_API_KEY`, `GLOFOX_API_TOKEN`, `GLOFOX_BRANCH_ID` | Glofox 3-header auth |
| `GLOFOX_MODE` | `mock` / `readonly` / `live` |
| `SAUNA_CLASS_TYPE_ALLOWLIST` | Comma-separated PushPress `classTypeName`s to mirror (currently `"Sauna"`) |
| `SAUNA_PLAN_CATEGORY_ALLOWLIST` | Comma-separated plan `category.name`s for enrollments (currently `"Sauna"`) |
| `CRON_SECRET` | Required for reconcile-cron auth (set in Supabase secrets, not just .env.local) |
| `SLACK_OPS_WEBHOOK_URL` | Optional. Empty = alerts silent |

## Specialized agents/skills

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
| Edge Function deploy | Supabase MCP `deploy_edge_function` (NOT the local CLI — needs Docker) |
| Supabase secrets | Management API curl with PAT from macOS keychain |

## Cross-project context

When you need details about TSG's Glofox usage, read from `~/Code/meridian-fresh/lib/glofox/` and `~/Code/meridian-fresh/CLAUDE.md`. The 3-header auth pattern + rate-limit pacing are battle-tested there.

**Do NOT modify Meridian from here.** Cross-reference only.
