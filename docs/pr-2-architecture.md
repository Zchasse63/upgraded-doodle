# PR 2 Architecture Blueprint

> Produced by `feature-dev:code-architect` on 2026-05-11 after Phase C-1 + NOEQL discovery. Authoritative over prior session notes.

## Scope

`enrollment.created` handler end-to-end (create-only). Cancel/pause flows defer to PR 3. PR 2 unblocks Phase C-2 by giving test users eligible Glofox NOEQL memberships so the reservation booking path can actually succeed.

## Design decisions (resolved)

| # | Question | Resolution |
|---|---|---|
| DQ1 | Filter env var for plan category | **Separate `SAUNA_PLAN_CATEGORY_ALLOWLIST`**, parallel to `SAUNA_CLASS_TYPE_ALLOWLIST`. Different resource types, different change cadence. |
| DQ2 | Handler deps | Reuse module-scope memoized `glofox()` and `pushpress()` accessors in `index.ts`. Identical pattern to `reservation.created`. |
| DQ3 | Unmapped plan behavior | **Option A — `status='failed', error='unmapped_plan:<id>'`, no `pending_refund` enqueue.** Unmapped plan is an ops config gap, not a billing event. |
| DQ4 | Promo code passing | Omit `promo_code` from request body when `NULL`; include it only when non-null. |
| DQ5 | start_date | Use `enrollment.startDate.slice(0,10)` from payload when present; fall back to `new Date().toISOString().slice(0,10)` (UTC today). No timezone conversion — cosmetic with $0 net. |
| DQ6 | Reconciliation script | **One `scripts/reconcile.ts`** (rename from `reconcile-reservations.ts`) with `--mode reservations\|enrollments\|all`. |
| DQ7 | Glofox purchase response shape | **Defensive 4-field parser**: try `res?.data?._id`, `res?.data?.userMembershipId`, `res?.data?.id`, `res?.data?.membership?._id`. Null result → warning log + `status='success'`. **Don't fail on missing ID** — the membership was assigned if Glofox returned 2xx; failing would cause replay double-assign. |

## Files

### NEW

| Path | Purpose |
|---|---|
| `supabase/functions/pushpress-webhook/handlers/enrollment-created.ts` | The new handler. See §Handler flow. |
| `supabase/migrations/0004_plan_mappings_promo.sql` | `ALTER TABLE plan_mappings ADD COLUMN glofox_promo_code text` |
| `supabase/migrations/0005_plan_mappings_seed.sql` | Seeds 3 NOEQL plan rows for our test users (`ON CONFLICT DO UPDATE` — idempotent). |
| `tests/enrollment-created.test.ts` | 8 cases mirroring `tests/integration.test.ts` shape. |
| `docs/pr-2-architecture.md` | This blueprint. |

### MODIFY

| Path | Change |
|---|---|
| `supabase/functions/_shared/filter.ts` | Add `isSaunaPlanCategory` + `getSaunaPlanCategoryAllowlist` + `_resetPlanCategoryForTests` (mirror existing class-type triple). |
| `supabase/functions/_shared/pushpress-client.ts` | Add `getPlan(planId)` method + `PushPressPlan` interface (`{id, name, companyId, category: {name}}`). |
| `supabase/functions/_shared/types.ts` | Extend `GlofoxClientShape` with `purchaseMembership(...)`; add `PlanMapping` interface. |
| `supabase/functions/_shared/glofox-client.ts` | Implement `purchaseMembership` on `GlofoxClient` + `GlofoxReadOnlyClient` (throws `GlofoxWriteBlocked`) + `GlofoxMockClient` (returns fixed userMembershipId). |
| `supabase/functions/_shared/mappings.ts` | Add `getPlanMapping(supabase, planId)`. Looks up active mapping row. |
| `supabase/functions/pushpress-webhook/index.ts` | Replace `enrollment.created: skipped` with `handleEnrollmentCreated` wiring (same deps as reservation.created). |
| `tests/filter.test.ts` | Add 6 cases for `isSaunaPlanCategory`. |
| `.env.example` | Add `SAUNA_PLAN_CATEGORY_ALLOWLIST` block. |

### RENAME

- `scripts/reconcile-reservations.ts` → `scripts/reconcile.ts` — add `--mode` flag + enrollment audit/replay path. Reservation logic unchanged.

## Handler flow

```
data = body.data as { id?, customerId?, companyId?, planId?, startDate? }

1. Guard: missing id || customerId → failed
2. Guard: missing planId → failed (error='missing_planId')
3. ppPlan = pushpress.getPlan(data.planId)
   throw → failed
4. Filter: !isSaunaPlanCategory(ppPlan.category.name) → filtered (error='plan_category_not_in_allowlist:...')
5. planMapping = getPlanMapping(supabase, data.planId)
   null → log + failed (error='unmapped_plan:<planId>')  -- NO pending_refund (DQ3)
6. memberLink = getOrCreateMemberLink(supabase, glofox, pushpress, data.customerId)
   throw → failed (error='member_unlinkable: ...')  -- no pending_refund here either
7. startDate = data.startDate ? data.startDate.slice(0,10) : new Date().toISOString().slice(0,10)
8. TRY: purchase = glofox.purchaseMembership({
     userId: memberLink.glofoxUserId,
     membershipId: planMapping.glofoxMembershipId,
     planCode: planMapping.glofoxPlanCode,
     paymentMethod: planMapping.paymentMethod,
     promoCode: planMapping.glofoxPromoCode ?? undefined,
     startDate
   })
   CATCH GlofoxApiError → failed (with response detail)
9. return { status:'success', glofoxResponse: { userMembershipId: purchase.userMembershipId } }
   // userMembershipId may be null (DQ7) — still success.
```

## Glofox `purchaseMembership` request shape

```
POST /2.2/branches/{branchId}/users/{userId}/memberships/{membershipId}/plans/{planCode}/purchase
{
  "payment_method": "<paymentMethod>",
  "start_date": "YYYY-MM-DD",
  "promo_code": "<promoCode>"   // omit entirely when null
}
```

Response parser (defensive):
```typescript
const id = res?.data?._id
  ?? res?.data?.userMembershipId
  ?? res?.data?.id
  ?? res?.data?.membership?._id
  ?? null;
```

## Migration 0005 — seed rows

```sql
insert into plan_mappings (pushpress_plan_id, pushpress_plan_name, glofox_membership_id, glofox_plan_code, payment_method, glofox_promo_code, is_active, notes) values
  ('plan_1b27d4595fa44a', 'Sauna 8 Pack (Recurring)',  '69fe0e2c238a9b2cd206fa15', '1778259589341', 'complimentary', 'TESTCODE', true, 'NOEQL 8-Class ($1/mo, 8 sessions)'),
  ('plan_4bc45a1bda3241', 'Sauna 4 Pack (Recurring)',  '69fe0e2c238a9b2cd206fa15', '1778259566576', 'complimentary', 'TESTCODE', true, 'NOEQL 4-Class ($1/mo, 4 sessions)'),
  ('plan_2be74145dfef43', 'Sauna Unlimited (Recurring)', '69fe0e2c238a9b2cd206fa15', '1778257393182', 'complimentary', 'TESTCODE', true, 'NOEQL Unlimited ($1/mo)')
on conflict (pushpress_plan_id) do update set
  pushpress_plan_name  = excluded.pushpress_plan_name,
  glofox_membership_id = excluded.glofox_membership_id,
  glofox_plan_code     = excluded.glofox_plan_code,
  payment_method       = excluded.payment_method,
  glofox_promo_code    = excluded.glofox_promo_code,
  notes                = excluded.notes;
```

## Tests (handler) — 8 cases

1. Happy path → `success`, `userMembershipId` set
2. Non-sauna plan (category="Membership Plans") → `filtered`
3. Unmapped plan (no `plan_mappings` row) → `failed`, `error='unmapped_plan:<id>'`
4. Member unlinkable (`pushpress.getCustomer` throws) → `failed`
5. Glofox `purchaseMembership` throws `GlofoxApiError` → `failed`
6. Glofox returns null `userMembershipId` → still `success` (logged)
7. Missing `planId` → `failed`, `error='missing_planId'`
8. Missing `customerId` → `failed`

## Reconciliation extension

`scripts/reconcile.ts --mode enrollments` (default `--mode all`):

1. `GET /enrollments?status=active&limit=100` paginated through PushPress
2. For each, `GET /plans/{planId}` → filter by `category.name` in `SAUNA_PLAN_CATEGORY_ALLOWLIST`
3. For each sauna enrollment, check `event_log` for a row with `pushpress_event='enrollment.created' AND payload->data->>'id' = <id> AND handler_status NOT IN ('failed','filtered','skipped')`
4. Report gaps
5. With `--replay`: synthesize signed `enrollment.created` webhook payload + POST to function

## Build sequence

1. Migrations 0004 + 0005 → `supabase db push` against live DB
2. Shared modules: filter, pushpress-client.getPlan, types (PlanMapping + interface extension), glofox-client.purchaseMembership (all 3 classes), mappings.getPlanMapping
3. Handler: handlers/enrollment-created.ts
4. Wire in index.ts
5. Tests: filter.test.ts (extend) + enrollment-created.test.ts (new)
6. Reconcile.ts rename + extend
7. .env.example update
8. Review (code-reviewer + security agent)
9. Simplify
10. Deploy via MCP
11. Set `SAUNA_PLAN_CATEGORY_ALLOWLIST=Sauna` in Supabase secrets
12. Audit via `reconcile.ts --mode enrollments` — expect 3 gaps (Zach, Jimmy, Marshall)
13. Replay in readonly mode — confirm pipeline reaches `purchaseMembership` and gets blocked cleanly
14. Switch `GLOFOX_MODE=live`, re-replay — expect 3 real Glofox memberships assigned
15. Verify in Glofox dashboard (3 members now on NOEQL memberships)
16. Switch back to readonly
17. Proceed to Phase C-2 (reservation booking)

## Pre-conditions before live replay

1. `SAUNA_PLAN_CATEGORY_ALLOWLIST=Sauna` must be set in Supabase secrets (otherwise every enrollment → filtered)
2. `payment_method='complimentary'` accepted by Glofox (Q1) — unverified, will discover on first live replay. If rejected, update `plan_mappings.payment_method` and re-replay; no code change needed.

## Open question status

- **Q5 ANSWERED**: NOEQL `_id=69fe0e2c238a9b2cd206fa15` with 3 plan codes
- **Q1 INVESTIGATING**: `complimentary` is best candidate, will confirm on live replay
- **Q9 RESOLVED for enrollments**: `Plan.category.name = "Sauna"`, env-var driven

Ready for implementation? **Y** with the two pre-conditions above.
