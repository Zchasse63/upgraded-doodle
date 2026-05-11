# Glofox

Class management and analytics platform. The Sauna Guys' (TSG's) system of record for memberships, bookings, attendance, transactions, and member profiles. Cross-referenced via [Meridian](https://github.com/Zchasse63/meridian-fresh) for operator workflows.

For the full per-endpoint surface that the middleware calls, see [`api-surface.md`](api-surface.md). This page is the orientation layer.

## What we use it for

- **Resolving customers**: looking up Glofox `user.id` from email via `POST /v3.0/namespaces/members/retrieve`; creating leads when no match exists.
- **Assigning memberships**: when a CC member buys the Sauna add-on in PushPress, we assign the corresponding Glofox membership without charging.
- **Cancelling memberships**: when PushPress fires `enrollment.status.changed → canceled`.
- **Booking class slots**: when a CC member books a sauna session in PushPress.
- **Cancelling bookings**: when a CC member or staff cancels.
- **Marking attendance**: on `checkin.created`.
- **Resolving event/class IDs**: lazy-cache lookup against the Glofox schedule by start time.

We do NOT subscribe to Glofox's CDC webhooks in v1 (subscription requires emailing `glofox.APISupport@abcfitness.com` — out of scope for the sandbox phase).

## Authentication (3-header — all required)

| Header | Value |
|---|---|
| `x-api-key` | The TSG Glofox API key |
| `x-glofox-api-token` | The TSG Glofox API token |
| `x-glofox-branch-id` | The TSG Glofox branch UUID |

**Missing any one header → Glofox returns `HTTP 200` with `{ success: false }` in the body.** This is a known quirk: always check both the HTTP status AND `response.success`. From Meridian's `lib/glofox/client.ts`:

```typescript
if (!response.ok || !response.success) {
  throw new GlofoxApiError(...)
}
```

The branch UUID is the same value as the location for single-location studios (TSG is one location).

## Server URL

| Environment | URL |
|---|---|
| Production | `https://gf-api.aws.glofox.com/prod/` |
| Sandbox | (Meridian uses production; sandbox is reserved for higher-volume testing per ABC Fitness — see Meridian docs) |

## Rate limits (verified, not theoretical)

| Environment | Limit |
|---|---|
| Live | 10 req/sec |
| Sandbox | 3 req/sec |
| Burst | 1000 / 300s |

Meridian's `lib/glofox/client.ts` paces page-walking at **120ms between pages** to stay well under the live limit. Bridge traffic is much lower volume than Meridian's bulk syncs, so we can rely on the same pacing.

## Quirks (you will hit these)

### 1. `200 OK` with `success: false`

The single most common failure mode. Caused by:

- Missing one of the three auth headers
- Wrong branch UUID
- Mis-cased header name (HTTP says it's fine, Glofox apparently doesn't always tolerate it)

**Always** parse the response body and check `success` before trusting the response.

### 2. Transactions use a non-REST endpoint

For transaction history, Glofox uses an Analytics endpoint that doesn't look like REST:

```
POST /Analytics/report
{
  "model": "TransactionsList",
  "filters": { "start": "1714200000", "end": "1716800000" }
}
```

Notes:
- `start` / `end` are **STRING** unix-second timestamps. Not numbers, not ISO 8601.
- Response unwraps via `TransactionsList.details[]`, not `data[]`.
- The bridge does not currently use this endpoint — payments are handled in PushPress.

### 3. Programs use POST, not GET

```
POST /v3.0/locations/{branch}/search-programs
```

If you GET it, you get nothing. Not a typo.

### 4. Pagination is `page=1`-based, `limit=100`

Some endpoints return `has_more`; others require length-based detection (if you got 100 results, try page 2; if you got <100, stop).

### 5. `branch` and `location` are interchangeable

For single-location studios (TSG is one location), the branch UUID and the location UUID are the same value. Endpoints inconsistently use both terms — same value either way.

## Cross-reference: Meridian's Glofox knowledge

The Meridian repo at `~/Code/meridian-fresh/` has a battle-tested Glofox REST client. Key files for porting / reference:

| Meridian file | Purpose |
|---|---|
| `lib/glofox/client.ts` | REST client with the 3-header auth, rate-limit pacing, success-flag checking |
| `lib/glofox/transformers.ts` | Glofox response → internal shape conversions. Encodes shape knowledge that isn't in any spec. |
| `lib/glofox/sync-engine.ts` | The hourly read-only sync. Confirms there's no existing membership-write code path. |
| `CLAUDE.md` § "Glofox quirks" | The same quirks documented in this file, distilled to a paragraph |

**Port these patterns to Deno-flavored TS for `_shared/glofox-client.ts`.** Don't re-derive from scratch.

## Reference

- **Per-endpoint surface**: [`api-surface.md`](api-surface.md)
- **Glofox OpenAPI 2.2 spec**: Owned by ABC Fitness. The PushPress-side handoff session retrieved a copy as `specs/glofox-openapi.yaml`. If we need to refer to it, ask the user for the local file path.
