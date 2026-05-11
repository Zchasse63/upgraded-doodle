// Unit tests for the idempotency key generator.
// Run with: deno test tests/dedup.test.ts

import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeDedupKey } from "../supabase/functions/_shared/dedup.ts";
import type { PushPressWebhookBody } from "../supabase/functions/_shared/types.ts";

function bodyFor(overrides: Partial<PushPressWebhookBody> = {}): PushPressWebhookBody {
  return {
    event: "reservation.created",
    created: 1715443200,
    data: {
      id: "11111111-1111-1111-1111-111111111111",
      companyId: "44444444-4444-4444-4444-444444444444",
    },
    ...overrides,
  };
}

Deno.test("computeDedupKey: deterministic — same input, same output", async () => {
  const a = await computeDedupKey(bodyFor());
  const b = await computeDedupKey(bodyFor());
  assertEquals(a, b);
});

Deno.test("computeDedupKey: output is 64-char lowercase hex (SHA-256)", async () => {
  const key = await computeDedupKey(bodyFor());
  assertEquals(key.length, 64);
  assertEquals(key, key.toLowerCase());
  assertEquals(/^[0-9a-f]{64}$/.test(key), true);
});

Deno.test("computeDedupKey: different event → different key", async () => {
  const a = await computeDedupKey(bodyFor({ event: "reservation.created" }));
  const b = await computeDedupKey(bodyFor({ event: "reservation.canceled" }));
  assertNotEquals(a, b);
});

Deno.test("computeDedupKey: different data.id → different key", async () => {
  const a = await computeDedupKey(bodyFor());
  const b = await computeDedupKey(
    bodyFor({
      data: {
        id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        companyId: "44444444-4444-4444-4444-444444444444",
      },
    }),
  );
  assertNotEquals(a, b);
});

Deno.test("computeDedupKey: different created → different key", async () => {
  const a = await computeDedupKey(bodyFor({ created: 1715443200 }));
  const b = await computeDedupKey(bodyFor({ created: 1715443201 }));
  assertNotEquals(a, b);
});

Deno.test("computeDedupKey: missing data.id falls back to empty string (no throw)", async () => {
  const key = await computeDedupKey(
    bodyFor({ data: { companyId: "44444444-4444-4444-4444-444444444444" } }),
  );
  assertEquals(key.length, 64);
});

Deno.test("computeDedupKey: missing data.companyId (enrollment.deleted slim payload) handled", async () => {
  const key = await computeDedupKey(
    bodyFor({
      event: "enrollment.deleted",
      data: { id: "11111111-1111-1111-1111-111111111111" },
    }),
  );
  assertEquals(key.length, 64);
});

Deno.test("computeDedupKey: id with pipe character does NOT collide with adjacent key", async () => {
  // Defensive: ensure our `|` separator can't be forged by a payload field.
  // (PushPress IDs are UUIDs so this should never happen in practice, but
  // verify the hash still differs for adversarial inputs.)
  const a = await computeDedupKey(
    bodyFor({ data: { id: "aaa", companyId: "bbb" } }),
  );
  const b = await computeDedupKey(
    bodyFor({ data: { id: "aaa|", companyId: "bbb" } }),
  );
  assertNotEquals(a, b);
});
