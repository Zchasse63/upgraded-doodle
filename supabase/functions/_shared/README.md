# `_shared/` — code shared across Edge Functions

This directory will hold code imported by `pushpress-webhook/` and any future Edge Functions (admin tools, manual replay endpoint, health check, etc.). PR 1 in the next session populates it with:

```
_shared/
├── glofox-client.ts       — port of ~/Code/meridian-fresh/lib/glofox/client.ts
│                            adapted for Deno (no Node-only APIs). The
│                            3-header auth, rate-limit pacing, 200+success:false
│                            handling, and POST /Analytics/report quirks all
│                            need to come over verbatim.
├── glofox-types.ts        — Zod schemas for Glofox responses. There is no
│                            official Glofox OpenAPI we can codegen from
│                            (Meridian's transformers in lib/glofox/transformers.ts
│                            encode much of the shape knowledge).
├── pushpress-types.ts     — Re-export of the @pushpress/pushpress types we
│                            actually use (Customer, Enrollment, Reservation,
│                            Checkin union, Class, etc.). Optionally narrow
│                            to a project-local discriminated union over the
│                            9 events we handle.
├── signature.ts           — HMAC-SHA256 verification mirroring the SDK's
│                            webhook-security-custom.ts. Pure function so
│                            it's trivial to unit-test against recorded
│                            payloads.
├── dedup.ts               — SHA-256 of `${event}|${data.id}|${data.companyId}|${created}`
│                            for idempotency. Pure function.
├── event-log.ts           — INSERT/SELECT helpers for the event_log table.
│                            Service-role client wrapper.
├── mappings.ts            — Read/write helpers for plan_mappings,
│                            slot_mappings, members_link, pending_refunds.
└── logger.ts              — Tiny structured logger (JSON to stdout). No
                              external deps; Supabase's log drain picks up
                              stdout JSON automatically.
```

## Rules

- **No npm**. Deno-friendly imports only — `https://esm.sh/...` for ESM packages, `https://deno.land/std@...` for stdlib. The PushPress SDK can be imported via `https://esm.sh/@pushpress/pushpress@1.15.0` once we need it (probably for the `validateWebhook` helper or the type re-exports — we may not need its HTTP client since we're only consuming inbound webhooks).
- **No side effects at import time.** No `console.log`, no env reads in top-level. Modules export pure functions or factory functions taking config.
- **One concern per file.** Don't grow `_shared/utils.ts` — split by domain.
- **Mirror Meridian patterns where they apply.** The Glofox 3-header auth, rate-limit pacing at 120ms between pages, and the `/Analytics/report` POST shape are battle-tested in `~/Code/meridian-fresh/lib/glofox/client.ts`. Port that knowledge, don't re-derive it.
