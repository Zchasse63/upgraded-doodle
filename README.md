# tsg-cc-bridge

One-way webhook middleware that mirrors **PushPress** events into **Glofox**.

## What this is

The Sauna Guys (TSG) runs Glofox as its system of record for memberships, bookings, attendance, and analytics. Cigar City CrossFit (CC, the gym TSG operates inside of) runs PushPress for member management. CC members will buy a "Sauna + Cold Plunge Add-on" plan inside PushPress, book sauna sessions through PushPress's branded app, and have all that activity mirrored into Glofox so TSG's existing operator workflows continue to work.

```
PushPress events ──webhook──► Supabase Edge Function ──REST──► Glofox API
```

Direction is **one-way**. We never write back to PushPress beyond outbound messages (push notifications). Standalone TSG members continue to book directly in Glofox unchanged — only CC-channel bookings flow through this middleware.

## Stack

- **Runtime**: Supabase Edge Functions (Deno)
- **DB**: Supabase Postgres (separate project from Meridian — schema-isolated)
- **Source PushPress SDK**: `@pushpress/pushpress@1.15.0` (TypeScript / Speakeasy-generated)
- **Glofox**: REST against `gf-api.aws.glofox.com/prod` (3-header auth)
- **Language**: TypeScript (Edge Functions are Deno-flavoured TS)

## Status

Pre-PR-1. This repo contains:

- Architecture and reference docs (`docs/`)
- Initial schema migration (`supabase/migrations/0001_initial.sql`) — mapping + audit tables
- Scaffolded Edge Function entry point (`supabase/functions/pushpress-webhook/index.ts`) — handler skeleton, no business logic yet

The actual webhook handler, Glofox client port, and admin tooling are PR 1 in the next development session. See [`docs/pr-1-plan.md`](docs/pr-1-plan.md).

## Documentation

Read in this order:

1. [`docs/handoff-from-meridian.md`](docs/handoff-from-meridian.md) — context from the planning session that produced this repo
2. [`docs/architecture.md`](docs/architecture.md) — the full system design (data flow, event handlers, failure modes)
3. [`docs/open-questions.md`](docs/open-questions.md) — live blocker list
4. [`docs/pr-1-plan.md`](docs/pr-1-plan.md) — initial PR scope

Reference material:

- [`docs/pushpress/README.md`](docs/pushpress/README.md) — PushPress overview, auth, quirks
- [`docs/pushpress/sdk-reference.md`](docs/pushpress/sdk-reference.md) — full SDK reference for `@pushpress/pushpress@1.15.0`
- [`docs/pushpress/webhook-events.md`](docs/pushpress/webhook-events.md) — webhook event catalog with payload shapes
- [`docs/glofox/README.md`](docs/glofox/README.md) — Glofox overview + quirks
- [`docs/glofox/api-surface.md`](docs/glofox/api-surface.md) — every Glofox endpoint the middleware calls

## Getting started

```bash
# 1. Copy env template and fill in values
cp .env.example .env.local

# 2. Install Supabase CLI if you don't have it
brew install supabase/tap/supabase

# 3. Link to your Supabase project (create one first if needed)
supabase link --project-ref <your-project-ref>

# 4. Apply the initial migration
supabase db push

# 5. Serve functions locally (requires Docker)
supabase functions serve pushpress-webhook --env-file .env.local
```

The webhook endpoint will be available at `http://localhost:54321/functions/v1/pushpress-webhook` for local testing.

## License

Private. Owned by The Sauna Guys.
