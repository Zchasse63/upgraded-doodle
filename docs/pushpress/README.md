# PushPress

Member management platform for gyms and studios. Used by **Cigar City CrossFit** in this integration; **The Sauna Guys** uses a free PushPress account as a sandbox during development.

For the full SDK / API surface, see [`sdk-reference.md`](sdk-reference.md). This page is the orientation layer.

## What we use it for

- Listening for webhooks when a CC member buys / cancels the Sauna add-on or books a sauna slot
- Looking up a customer's full record on first encounter (`customers.get`)
- Resolving a class by ID to get its start time when caching slot mappings (`classes.get`)
- Sending outbound push notifications when a member's booking can't be mirrored (`messages.push.send`)

We do **not** create reservations, check-ins, plans, or memberships via the API — those don't have public write endpoints. Customers can be created via API but **only as leads**, not as paying members (member creation goes through PushPress's UI).

## Authentication

- **Header**: `API-KEY: <value>` (uppercase, hyphenated)
- **Key format**: opaque colon-separated string, looks like `sk_xxxxxxxxxxxxxxxx:yyyyyyyyyyyyyyy`. The SDK treats it as a single opaque string.
- **Company header**: every supported operation also sends `company-id: <uuid>` (the PushPress company UUID).
- **Webhook signature**: per-subscription HMAC-SHA256 secret in `webhook-signature` header. **Custom scheme** — see [`sdk-reference.md` § Webhooks](sdk-reference.md#webhooks).

The SDK pulls credentials from `PUSHPRESS_API_KEY` env var by default. We override explicitly to make config visible.

## Server URLs

| Environment | URL |
|---|---|
| Production | `https://api.pushpress.com/v3` |
| Staging | `https://api.pushpressstage.com/v3` |
| Development | `https://api.pushpressdev.com/v3` |

We use **production** for the TSG-PushPress sandbox account — PushPress doesn't issue staging credentials for free accounts. When we go live with CC, we stay on production.

## Rate limits

**Not documented.** The SDK defines a `RateLimited` error (HTTP 429) and applies it to 8 of 49 operations, so limits exist. We don't know the values. Expected traffic is tiny (single tenant, ~5–10 calls per booking event peak) so this is unlikely to bite.

If we hit 429s in practice: back off exponentially, log the event, and ask PushPress for the actual limits.

## Webhook delivery

PushPress POSTs each event to our subscribed URL with three notable headers:

| Header | Purpose |
|---|---|
| `webhook-signature` | HMAC-SHA256 hex digest, computed over `JSON.stringify(body.data)` using the per-subscription signing secret |
| `content-type` | `application/json` |
| `user-agent` | Identifies as PushPress |

There is **no** `webhook-timestamp` or `webhook-id` header (PushPress does not use Svix / standard-webhooks).

**Retry policy is not documented.** Treat retries as possible — dedup with [`event_log`](../architecture.md#4b-idempotency) using a SHA-256 of `{event, data.id, data.companyId, created}`.

## Quirks to remember

1. **`createCustomer` only creates leads.** Cannot create active members via API.
2. **Reservation status `"checked-in"` is hyphenated**; enrollment status `"pendactivation"` is one word. Don't hand-type enum values — import them from the SDK.
3. **Mixed timestamp units.** Webhook `created`, class `start`/`end`, checkin `timestamp` are Unix seconds. API-key timestamps are milliseconds. Enrollment dates are `YYYY-MM-DD` strings.
4. **Webhook payloads for `*.deleted` events are slim.** `customer.deleted` payload is just `{ id, companyId }`. `enrollment.deleted` is just `{ id }`. Plan accordingly.
5. **Two subscribable events have no SDK type:** `memberapp.updated` and `reservation.noshowed`. Subscribing to those will raise validation errors. We do not subscribe to either.
6. **`signingSecret` is only returned at webhook-creation time.** If lost, rotate it via `POST /webhooks/{uuid}/rotate-signing-secret`.

## Subscription setup (out-of-band)

The PushPress webhook subscription needs to be created via the API once, then its `signingSecret` saved to `PUSHPRESS_WEBHOOK_SIGNING_SECRET`. Procedure:

1. Stand up the Edge Function so it has a public URL (use a Supabase preview deploy or `ngrok` for local dev).
2. From a one-off script or Supabase SQL editor, call `POST /webhooks` with:
   - `url: "https://<your-supabase-project>.functions.supabase.co/pushpress-webhook"`
   - `eventTypes: ["enrollment.created", "enrollment.status.changed", "enrollment.deleted", "reservation.created", "reservation.canceled", "reservation.waitlisted", "checkin.created", "class.canceled", "customer.details.changed"]`
3. Record the returned `signingSecret` immediately.
4. Save to `.env.local` and to the Supabase project's secret store (`supabase secrets set PUSHPRESS_WEBHOOK_SIGNING_SECRET=...`).

This is a manual step. Automating it is a PR 3+ concern.

## Reference

- **Full SDK reference**: [`sdk-reference.md`](sdk-reference.md) — every type, operation, and quirk
- **Webhook event catalog**: [`webhook-events.md`](webhook-events.md) — per-event payload shapes and middleware behavior
- **npm package**: <https://www.npmjs.com/package/@pushpress/pushpress/v/1.15.0>
- **GitHub**: <https://github.com/PushPress/pushpress-ts> (may 404 if private)
