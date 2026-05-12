# Groupon discount bulk-upload — Glofox dashboard workaround

How to bulk-upload Groupon promo codes into TSG's Glofox account. This is a workaround for a documented gap: Glofox's public REST API has no endpoints for creating discounts or promo codes, and Glofox's own engineering doesn't have a bulk-import tool. The dashboard supports one-at-a-time creation via a private internal API; we replay those same HTTP calls in bulk.

## The constraint we hit

Glofox enforces a **hard cap of 100 discount entities per account** (one of the 100s the dashboard manages — verified via direct probe 2026-05-12 with error `MAX_DISCOUNTS_REACHED`). This is a per-tenant ceiling, not a per-batch one, so it includes any pre-existing manually-created discounts (NOEQL, STUDENTDROPIN, employee codes, etc.).

For TSG's two parallel Groupon campaigns:
- **Groupon 1** ("Groupon for 1") — 500 codes, 20% off Single Class Drop-in
- **Groupon 2** ("Groupon for 2") — 500 codes, 25% off Single Class Drop-in

Total = 1000 codes; account cap = 100. **You can't upload all of them.** The chosen strategy (2026-05-12) was to balance the two campaigns: 43 of each = 86 Groupon discounts + 13 non-Groupon = 99 (1 slot of headroom).

Each code in the CSV that's NOT currently in Glofox is "queued" — it sits in the CSV with `GlofoxStatus=not_uploaded` waiting for capacity. When capacity opens up (e.g., Glofox raises the cap, or you delete codes from one campaign to upload the other), re-run the balance script.

## What lives where

| Path | Purpose |
|---|---|
| `scripts/balance-groupon-discounts.ts` | The main tool. Deletes excess of one campaign + uploads more of the other, then writes status back to CSVs. Idempotent, dry-run by default. |
| `scripts/bulk-upload-groupon-codes.ts` | The earlier single-campaign uploader. Useful when you just want to upload (no rebalance) and you have headroom. Also idempotent — pre-checks against existing promo codes. |
| `scripts/groupon-1-codes.csv` | Groupon-1 codes with `GlofoxStatus` column. Gitignored. |
| `scripts/groupon-2-codes.csv` | Groupon-2 codes with `GlofoxStatus` column. Gitignored. |
| `scripts/balance-results-*.json` | Per-run audit logs (which codes were created/deleted/failed). Gitignored. |

## Endpoints used (none in the public OpenAPI spec)

All on `https://app.glofox.com/discount-api/v1` — the dashboard's internal API. **None of these are in the public Glofox REST docs.** They were discovered by capturing the network requests the dashboard makes when you click "Create discount" / "Delete discount" in DevTools.

| Action | Method | Path |
|---|---|---|
| List all discounts | `GET` | `/discount-api/v1/discounts` |
| List promo codes (paginated 25/page via `?page=N`) | `GET` | `/discount-api/v1/promo-codes` |
| Create discount | `POST` | `/discount-api/v1/studios/{studioId}/discounts` |
| Create promo code | `POST` | `/discount-api/v1/promo-codes` |
| Delete discount | `DELETE` | `/discount-api/v1/discounts/{id}` ← **NO studio segment** |

**The DELETE path is asymmetric with create** — create includes `/studios/{studioId}/` but delete does NOT. The studio-scoped DELETE path returns 405 Method Not Allowed. This bit us once (orphan cleanup silently no-op'd against the wrong path).

### Request shapes

**Create discount** (request body):
```json
{
  "name": "Groupon 2 - 6RH8NEWTXRKW",
  "description": "Groupon for 2",
  "rate_value": 25000,
  "num_cycles": 0,
  "rate_type": "percentage",
  "applies_to_joining_fee_only": false
}
```
- `rate_value` is scaled by 1000 (`25000` = `25.000%`, `100000` = `100%` off)
- `num_cycles: 0` = apply to all recurring membership payments
- Returns: `{ "id": "<uuid>", ...echo of request }`

**Create promo code** (request body):
```json
{
  "discount_id": "<uuid from create-discount response>",
  "code": "6RH8NEWTXRKW",
  "code_enabled": true,
  "usage_limit_per_user": 1,
  "max_usage_limit": 1,
  "assignments": [{
    "service_type": "memberships",
    "include": [{
      "service_id": "69d80c439f4158716c0068de",
      "sub_service_ids": ["1775766556749"]
    }]
  }],
  "utc_start_date": "2026-05-12T00:00:00-04:00",
  "utc_end_date": null
}
```
- `service_id` `69d80c43...` = "Single Class Drop-in" membership
- `sub_service_ids` `["1775766556749"]` = the plan code within that membership
- `max_usage_limit: 1` + `usage_limit_per_user: 1` = single-use, single-customer (Groupon standard)
- Returns: `{ "id": "<promo_uuid>", ...echo }`

## Auth

The dashboard uses **Bearer JWT** authentication (not the public API's 3-header scheme). The JWT:
- Is created when you log into the Glofox dashboard
- Lives in the browser's session storage / cookie
- Expires every **24 hours** (verified — `iat`/`exp` claims are 86400s apart)
- Can be captured from any authenticated `app.glofox.com` request in DevTools

Bonus headers the dashboard sends — include them all to look legitimate:
- `x-glofox-branch-id: 654e7d37c8a12ada310de13a`
- `x-glofox-branch-continent: NA`
- `x-glofox-branch-timezone: America/New_York`
- `x-glofox-source: dashboard`
- `x-glofox-dashboard-page: /discounts/definition`
- `x-glofox-dashboard-version: <build hash, e.g. dfe7f5ad7f36052b9199fa7b1de94acbf56d801a.202605112149>`

The dashboard version string is a build SHA + timestamp that may change between Glofox releases; if requests start failing after a dashboard update, grab a fresh capture and update the script's default.

## Capturing a fresh JWT (the manual step)

Each time you re-run the script, the JWT must be ≤24 hours old.

1. Log into [https://app.glofox.com/dashboard](https://app.glofox.com/dashboard)
2. Open DevTools → **Network** tab → enable **Preserve log** → filter for `app.glofox.com`
3. Navigate to **Manage → Discounts** in the sidebar — this fires multiple requests including the discount list GET
4. Click any of those `app.glofox.com` requests
5. In the Headers tab, find `Authorization: Bearer eyJhbGc...` → copy the token (without the `Bearer ` prefix)
6. Set the env var:
   ```bash
   export GLOFOX_DASHBOARD_JWT="eyJhbGc...the-token..."
   ```
7. The script auto-decodes the JWT's `exp` claim and warns if <10 min remaining

## Running the balance script

**Always dry-run first** — it shows what the plan WOULD do without modifying anything:

```bash
deno run --allow-net --allow-read --allow-env --allow-write \
  scripts/balance-groupon-discounts.ts
```

Sample dry-run output:
```
=== BALANCE PLAN ===
Mode:             DRY-RUN (no changes)
Target per side:  43
Cap:              100
Currently:        79 G1 / 7 G2 / 13 Other = 100
Actions:          DELETE 36 G1 + UPLOAD 36 G2
After plan:       43 G1 / 43 G2 / 13 Other = 100
```

If the plan looks right, re-run with `--execute`:

```bash
deno run --allow-net --allow-read --allow-env --allow-write \
  scripts/balance-groupon-discounts.ts --execute
```

That runs the deletes and uploads, paces at ~3 ops/sec, updates the CSVs, writes an audit log to `scripts/balance-results-<timestamp>.json`.

## Adjusting the target

The script has `TARGET_PER_GROUPON = 43` hardcoded near the top. To change the balance (e.g., if Glofox raises the cap):

1. Edit that constant in the script
2. Dry-run to see the new plan
3. Execute

For example, with a 200-cap, you might set `TARGET_PER_GROUPON = 93` (87 + 100 more = 200 - 14 other = 186 / 2 = 93 each).

## Adjusting which codes to keep/delete

The script keeps **the first N codes by CSV row order** and deletes the rest (when deleting). That keeps the boundary in the CSV clean: rows 1..43 are uploaded, rest are queued. If you'd rather keep different rows (e.g., delete oldest by upload date), edit the `g1ToDelete` slicing logic in the script — it's a single `.slice()` call.

## Resuming when JWT expires mid-run

The JWT is 24-hour. If it expires while the script is running, you'll see consecutive 401s in the output. The script detects this and stops early. To resume:

1. Capture a fresh JWT (steps above)
2. Re-run the same command — the dedup pre-fetch will skip codes already in Glofox, so you only re-attempt the unfinished work

## Known issues + watch-outs

1. **Discount-name uniqueness is NOT enforced.** You can create two discounts with the same name (e.g., two `Groupon 2 - 6RH8NEWTXRKW`). The script doesn't pre-check discount names — it pre-checks promo codes (which DO have uniqueness). If a promo create fails with `CODE_NOT_UNIQUE`, the orphan-discount cleanup deletes the newly-created discount.

2. **Promo-code list endpoint is paginated at 25/page.** Pre-fetch walks pages 1..N until empty. Cap at 50 pages (= 1250 codes) hardcoded; raise if needed.

3. **Some promo codes are invisible to the list endpoint.** During testing we found that `6RH8NEWTXRKW` (manually created via dashboard) existed in Glofox but was NOT returned by `GET /promo-codes` across any page. Yet Glofox correctly enforced uniqueness when we tried to recreate it. The list endpoint may filter by some criterion we haven't found (date? source? account permissions?). Implication: dedup pre-check can miss some codes; if a creation fails with `CODE_NOT_UNIQUE`, the orphan is cleaned up automatically — but the CSV's `GlofoxStatus` for that code stays `not_uploaded` because we couldn't see it. Spot-check via the dashboard if you suspect inconsistency.

4. **`utc_start_date` in script is hardcoded** to `"2026-05-12T00:00:00-04:00"`. Update if running in a different time period.

5. **`utc_end_date: null`** means codes never expire. If Groupon deals have a hard expiry, set this in the script.

6. **CSV updates are atomic per run.** The script writes both CSVs at the very end. If the process is killed mid-run (Ctrl-C), the CSVs reflect the LAST successful run, NOT the partial state. The audit JSON in `scripts/balance-results-*.json` is the source of truth for what happened.

## Automation: `groupon-rotate-cron`

A scheduled Edge Function that automates the "as codes get redeemed, upload the next from the queue" cycle. Built 2026-05-12.

### Architecture

```
                    Customer redeems Groupon code on Glofox
                                  │
                                  ▼
                    Glofox deletes the spent discount (or
                    flips state — TBD via observation)
                                  │
                                  ▼
   (every 30 min)  Supabase scheduler invokes groupon-rotate-cron
                                  │
                                  ▼
                   1. Pull current Glofox discount list
                   2. For each `uploaded` row in groupon_codes:
                      if its glofox_discount_id is gone → mark 'used'
                   3. For each campaign:
                      if (uploaded count) < 43:
                        pop next 'queued' codes in CSV row order
                        POST discount + POST promo-code
                        mark 'uploaded'
                   4. Record run in groupon_rotation_runs
                   5. Slack-alert on activity / errors / JWT expiry
```

### Tables (migration 0010)

`groupon_codes` — master record of all 1000 codes
- `code` (PK), `campaign` (`groupon_1` / `groupon_2`), `csv_row_index` (preserves upload order)
- `status` (`queued` / `uploaded` / `used` / `failed`)
- `glofox_discount_id`, `glofox_promo_code_id`, `uploaded_at`, `used_detected_at`, `failure_reason`

`groupon_rotation_runs` — one row per cron invocation
- Status counters, JWT expiry, per-campaign state snapshot

### Setup (one-time)

1. Apply migration 0010 (already done as of 2026-05-12 via Supabase MCP)
2. Bootstrap the table from current state:
   ```bash
   export GLOFOX_DASHBOARD_JWT="eyJhbGc..."
   deno run --allow-net --allow-read --allow-env scripts/bootstrap-groupon-codes.ts
   ```
   This reads both CSVs, cross-references with current Glofox state, and seeds 1000 rows.

3. Set the JWT secret in Supabase:
   ```bash
   deno run --allow-net --allow-env --allow-run scripts/update-glofox-jwt.ts "eyJhbGc..."
   ```
   The helper script decodes the JWT, validates expiry, and writes to Supabase secrets via Management API (uses macOS keychain PAT).

4. Deploy the Edge Function (already done):
   ```bash
   # via Supabase MCP deploy_edge_function
   ```

5. The schedule is in `supabase/config.toml`:
   ```toml
   [functions.groupon-rotate-cron]
   verify_jwt = false
   schedule = "0 13 * * *"  # daily at 13:00 UTC (9 AM EDT / 8 AM EST)
   ```

   Adjustable — if redemption volume grows and 24h latency is too long,
   bump to `*/15 * * * *` (15 min) or `0 */6 * * *` (every 6h). Each
   cron run is cheap (~2-3s, a handful of API calls).

### Daily operations

**Once per day** (or whenever the JWT expires), refresh:

1. Open Glofox dashboard in Chrome
2. DevTools → Network → grab Bearer token from any `app.glofox.com` request
3. Run:
   ```bash
   deno run --allow-net --allow-env --allow-run scripts/update-glofox-jwt.ts "eyJhbGc..."
   ```

The script tells you when the new JWT expires. After that point, the cron will Slack-alert and stop until refreshed.

**Manual cron invocation** (for testing or recovery after JWT refresh):
```bash
CRON_SECRET=$(grep "^CRON_SECRET=" .env.local | cut -d= -f2-)
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://pygbvcqjpwfodmoqkhos.supabase.co/functions/v1/groupon-rotate-cron"
```

Response:
```json
{
  "run_id": "<uuid>",
  "status": "no_op" | "success" | "jwt_expired" | "error",
  "detected_used": <int>,
  "successful_uploads": <int>,
  "per_campaign_state": { "groupon_1": {...}, "groupon_2": {...} }
}
```

### Detection logic

The cron detects "used" codes by checking if their `glofox_discount_id` is still in the discounts list. If a discount has been deleted (presumably because its single-use code was redeemed), the corresponding row gets marked `used`.

**Caveat**: this assumes Glofox auto-deletes discounts when their single-use codes are redeemed. We haven't directly observed this — we've only verified that manually-deleted discounts are caught correctly. If Glofox instead keeps used discounts around with some "spent" flag, detection won't work and we'll need a different signal. See the [open question in `docs/open-questions.md`](open-questions.md) — Q14 (post-redemption-behavior).

If detection is unreliable, fallback is manual: query Glofox usage stats periodically, mark codes used by hand via SQL.

### Slack alerts

- 🚨 `GLOFOX_DASHBOARD_JWT not set` or `expired` — refresh required
- ⚠️ JWT expires in <10 min — refresh soon
- ✓ Activity summary when codes were detected used or uploaded
- 🚨 Errors during a rotation run

Silent on `no_op` runs (cron ran, nothing changed) to avoid noise.

### Adjusting target counts

Edit `GROUPON_TARGET_PER_CAMPAIGN` env var (default 43). If Glofox raises the 100-cap, bump this up.

```bash
# Via Supabase Management API (same pattern as scripts/update-glofox-jwt.ts):
TOKEN=$(security find-generic-password -s "Servous Supabase PAT" -w)
curl -X POST "https://api.supabase.com/v1/projects/pygbvcqjpwfodmoqkhos/secrets" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '[{"name":"GROUPON_TARGET_PER_CAMPAIGN","value":"80"}]'
```

Next cron run will refill up to the new target.

---

## Future improvements (deferred)

- If Glofox raises the cap → bump `GROUPON_TARGET_PER_CAMPAIGN`, cron handles incremental adds cleanly
- If Glofox publishes a real API endpoint for discount creation → migrate to that and abandon the internal-API workaround
- If Glofox exposes promo-code redemption webhooks → swap the polling cron for event-driven; latency drops from 30 min to seconds
- Auto-refresh the JWT (e.g., headless-browser script that logs in nightly via stored credentials) — fragile and against TOS, deferred until a service-account becomes available

## See also

- [`docs/glofox/api-surface.md`](glofox/api-surface.md) — endpoints we use from the public Glofox REST API (different beast — Bearer JWT + 3-header auth, different paths)
- [`docs/glofox/README.md`](glofox/README.md) — known Glofox API quirks
- [`docs/open-questions.md`](open-questions.md) — questions we've sent or plan to send to Glofox API support
