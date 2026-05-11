// Unit tests for the PushPress webhook signature verifier.
// Run with: deno test --allow-env tests/signature.test.ts

import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyPushPressSignature } from "../supabase/functions/_shared/signature.ts";

// --- Helper -----------------------------------------------------------------
// Same math as the verifier, used in tests to produce known-good signatures.
// If verifier and signer ever disagree, the tests will fail.

async function signForTest(data: unknown, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Fixtures ---------------------------------------------------------------

const SECRET = "test-signing-secret-do-not-use-in-prod";
const VALID_BODY = {
  event: "reservation.created",
  created: 1715443200,
  data: {
    id: "11111111-1111-1111-1111-111111111111",
    reservedId: "22222222-2222-2222-2222-222222222222",
    customerId: "33333333-3333-3333-3333-333333333333",
    companyId: "44444444-4444-4444-4444-444444444444",
    registrationTimestamp: 1715443100,
    status: "reserved",
  },
};

// --- Tests ------------------------------------------------------------------

Deno.test("verifyPushPressSignature: valid signature passes", async () => {
  const sig = await signForTest(VALID_BODY.data, SECRET);
  assertEquals(await verifyPushPressSignature(VALID_BODY, sig, SECRET), true);
});

Deno.test("verifyPushPressSignature: wrong secret fails", async () => {
  const sig = await signForTest(VALID_BODY.data, SECRET);
  assertEquals(
    await verifyPushPressSignature(VALID_BODY, sig, "wrong-secret"),
    false,
  );
});

Deno.test("verifyPushPressSignature: tampered data field fails", async () => {
  const sig = await signForTest(VALID_BODY.data, SECRET);
  const tampered = {
    ...VALID_BODY,
    data: { ...VALID_BODY.data, customerId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
  };
  assertEquals(await verifyPushPressSignature(tampered, sig, SECRET), false);
});

Deno.test("verifyPushPressSignature: empty signature fails", async () => {
  assertEquals(await verifyPushPressSignature(VALID_BODY, "", SECRET), false);
});

Deno.test("verifyPushPressSignature: empty secret fails", async () => {
  const sig = await signForTest(VALID_BODY.data, SECRET);
  assertEquals(await verifyPushPressSignature(VALID_BODY, sig, ""), false);
});

Deno.test("verifyPushPressSignature: signature with uppercase hex still passes (case-insensitive)", async () => {
  const sig = (await signForTest(VALID_BODY.data, SECRET)).toUpperCase();
  assertEquals(await verifyPushPressSignature(VALID_BODY, sig, SECRET), true);
});

Deno.test("verifyPushPressSignature: malformed signature fails without throwing", async () => {
  assertEquals(
    await verifyPushPressSignature(VALID_BODY, "not-hex", SECRET),
    false,
  );
});

Deno.test("verifyPushPressSignature: signature for different body fails", async () => {
  const otherData = { id: "x", companyId: "y", foo: 1 };
  const sig = await signForTest(otherData, SECRET);
  assertNotEquals(sig, await signForTest(VALID_BODY.data, SECRET));
  assertEquals(await verifyPushPressSignature(VALID_BODY, sig, SECRET), false);
});

// Regression tests for the byte-level constant-time compare introduced after
// the security review flagged a string-length early-exit timing oracle.

Deno.test("verifyPushPressSignature: odd-length hex fails (parse rejection)", async () => {
  // 63 chars — can't be 32 bytes.
  const sig = "a".repeat(63);
  assertEquals(await verifyPushPressSignature(VALID_BODY, sig, SECRET), false);
});

Deno.test("verifyPushPressSignature: short hex fails (wrong byte length)", async () => {
  // 32 chars = 16 bytes — not a valid SHA-256.
  const sig = "0123456789abcdef0123456789abcdef";
  assertEquals(await verifyPushPressSignature(VALID_BODY, sig, SECRET), false);
});

Deno.test("verifyPushPressSignature: long hex fails (wrong byte length)", async () => {
  // 128 chars — too long.
  const sig = "0".repeat(128);
  assertEquals(await verifyPushPressSignature(VALID_BODY, sig, SECRET), false);
});

Deno.test("verifyPushPressSignature: 64-char string with non-hex chars fails", async () => {
  // Right length but `z` isn't a hex digit.
  const sig = "z".repeat(64);
  assertEquals(await verifyPushPressSignature(VALID_BODY, sig, SECRET), false);
});

// --- Fixture self-consistency ----------------------------------------------
// The signed fixture lives in tests/fixtures/. If we ever change the payload
// or the test secret, this test catches the drift before someone gets a
// confusing 401 in a manual curl test.

Deno.test("fixture: reservation.created.valid.json verifies against its .signature.txt", async () => {
  const FIXTURE_SECRET = "test-signing-secret-do-not-use-in-prod";
  const fixturePath = new URL("./fixtures/reservation.created.valid.json", import.meta.url);
  const sigPath = new URL("./fixtures/reservation.created.signature.txt", import.meta.url);

  const body = JSON.parse(await Deno.readTextFile(fixturePath));
  const sig = (await Deno.readTextFile(sigPath)).trim();

  assertEquals(await verifyPushPressSignature(body, sig, FIXTURE_SECRET), true);
});

Deno.test("fixture: tampered payload does NOT verify against the valid signature", async () => {
  const FIXTURE_SECRET = "test-signing-secret-do-not-use-in-prod";
  const tamperedPath = new URL(
    "./fixtures/reservation.created.tampered.json",
    import.meta.url,
  );
  const sigPath = new URL("./fixtures/reservation.created.signature.txt", import.meta.url);

  const body = JSON.parse(await Deno.readTextFile(tamperedPath));
  const sig = (await Deno.readTextFile(sigPath)).trim();

  assertEquals(await verifyPushPressSignature(body, sig, FIXTURE_SECRET), false);
});
