# Test fixtures

Recorded / synthetic webhook payloads for manual integration testing once a Supabase project is wired up.

| File | Purpose |
|---|---|
| `reservation.created.valid.json` | Synthetic payload. Has all required fields. Use with the signature below. |
| `reservation.created.signature.txt` | HMAC-SHA256 of `JSON.stringify(valid.json.data)` using the test secret `test-signing-secret-do-not-use-in-prod`. Send as the `webhook-signature` request header. |
| `reservation.created.tampered.json` | Same shape as `valid.json` with `data.customerId` changed. Reusing the valid signature with this payload MUST produce a 401 from the function. |

## Regenerating a signature

If you edit `reservation.created.valid.json`, regenerate its signature:

```bash
deno run --allow-read --allow-env scripts/generate-fixture-signature.ts \
  tests/fixtures/reservation.created.valid.json \
  test-signing-secret-do-not-use-in-prod \
  > tests/fixtures/reservation.created.signature.txt
```

Or with a real production secret (when testing against the live function):

```bash
PUSHPRESS_WEBHOOK_SIGNING_SECRET=...real-secret... \
  deno run --allow-read --allow-env scripts/generate-fixture-signature.ts \
  tests/fixtures/reservation.created.valid.json \
  > /tmp/sig.txt
```

## Manual end-to-end test (once Supabase is wired)

```bash
SIG=$(cat tests/fixtures/reservation.created.signature.txt)

# 1. Valid signed payload → 200 OK with status:"success" (mocked Glofox) or
#    status:"failed" / "filtered" depending on env config.
curl -sS -X POST http://localhost:54321/functions/v1/pushpress-webhook \
  -H "Content-Type: application/json" \
  -H "webhook-signature: $SIG" \
  --data-binary @tests/fixtures/reservation.created.valid.json | jq

# 2. Same POST again → 200 OK with status:"duplicate"
curl -sS -X POST http://localhost:54321/functions/v1/pushpress-webhook \
  -H "Content-Type: application/json" \
  -H "webhook-signature: $SIG" \
  --data-binary @tests/fixtures/reservation.created.valid.json | jq

# 3. Tampered payload (same signature) → 401 Invalid signature
curl -sS -X POST http://localhost:54321/functions/v1/pushpress-webhook \
  -H "Content-Type: application/json" \
  -H "webhook-signature: $SIG" \
  --data-binary @tests/fixtures/reservation.created.tampered.json

# 4. Verify event_log rows via supabase studio or psql:
#    select dedup_key, pushpress_event, signature_verified, handler_status, handler_error
#      from event_log order by received_at desc limit 5;
```
