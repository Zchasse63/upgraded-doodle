// Phase A test driver.
//
// Imports the Edge Function's handleRequest in-process and exercises it
// against the live Supabase + live PushPress sandbox + MOCK Glofox.
// No HTTP server, no docker, no real Glofox writes.
//
// Run with:
//   deno run --allow-net --allow-env --allow-read --env-file=.env.local \
//     scripts/test-drive.ts
//
// Scenarios:
//   1. Valid signed reservation for a real sauna class → status:"success"
//   2. Replay of (1)                                    → status:"duplicate"
//   3. Tampered signature                               → 401
//   4. Reservation for a real CrossFit class            → status:"filtered"
//   5. Reservation with bogus reservedId                → status:"failed"

import { handleRequest } from "../supabase/functions/pushpress-webhook/index.ts";

const SIGNING_SECRET = Deno.env.get("PUSHPRESS_WEBHOOK_SIGNING_SECRET") ?? "";
if (!SIGNING_SECRET) {
  console.error("PUSHPRESS_WEBHOOK_SIGNING_SECRET not set");
  Deno.exit(1);
}

// Real sandbox IDs (discovered earlier via /classes and /customers probes).
const SAUNA_CLASS_ID = "cal-f8081de2abde43ce8746ef66d963"; // "Open Sauna"
const CROSSFIT_CLASS_ID = "cal-b2303386bf814ff096dc561c4a7d"; // "CrossFit"
const ZACH_CUSTOMER_ID = "usr_788d5a14a582ad1386e14303a970ca52"; // exists in Glofox
const JIMMY_CUSTOMER_ID = "usr_699ec2318a3ea58b69f8721779c126b0"; // NOT in Glofox
const COMPANY_ID = "client_ddd1caa8be7225";

const ENC = new TextEncoder();

async function sign(data: unknown, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENC.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, ENC.encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function reservationBody(opts: {
  reservedId: string;
  customerId?: string;
  id?: string;
}): { event: string; created: number; data: Record<string, unknown> } {
  return {
    event: "reservation.created",
    created: Math.floor(Date.now() / 1000),
    data: {
      id: opts.id ?? `pp-res-test-${Date.now()}`,
      reservedId: opts.reservedId,
      customerId: opts.customerId ?? ZACH_CUSTOMER_ID,
      companyId: COMPANY_ID,
      registrationTimestamp: Math.floor(Date.now() / 1000) - 60,
      status: "reserved",
    },
  };
}

async function postWebhook(
  body: { event: string; created: number; data: Record<string, unknown> },
  options: { tamperSig?: boolean } = {},
): Promise<Response> {
  const sig = options.tamperSig
    ? "0".repeat(64)
    : await sign(body.data, SIGNING_SECRET);
  const rawBody = JSON.stringify(body);
  return handleRequest(
    new Request("http://localhost/functions/v1/pushpress-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(rawBody.length),
        "webhook-signature": sig,
      },
      body: rawBody,
    }),
  );
}

async function summary(label: string, res: Response): Promise<void> {
  const text = await res.text();
  console.log(`\n[${label}]`);
  console.log(`  HTTP: ${res.status}`);
  console.log(`  body: ${text}`);
}

// --- Scenarios ---

const MODE = Deno.env.get("GLOFOX_MODE") ?? "?";
const PHASE = { mock: "A", readonly: "B", live: "C" }[MODE] ?? "?";
console.log(`=== Phase ${PHASE}: GLOFOX_MODE=${MODE} ===\n`);
console.log(`SAUNA_CLASS_TYPE_ALLOWLIST=${Deno.env.get("SAUNA_CLASS_TYPE_ALLOWLIST")}`);
console.log(`SUPABASE_URL=${Deno.env.get("SUPABASE_URL")?.replace(/^https?:\/\//, "")}`);

// 1. Valid sauna reservation
const reservationId1 = `pp-res-test-${Date.now()}-saunaA`;
const body1 = reservationBody({ reservedId: SAUNA_CLASS_ID, id: reservationId1 });
await summary("1. Valid sauna reservation", await postWebhook(body1));

// 2. Replay of (1) → duplicate (same body, same signature)
await summary("2. Replay of (1) → duplicate", await postWebhook(body1));

// 3. Tampered signature on a fresh body
const body3 = reservationBody({
  reservedId: SAUNA_CLASS_ID,
  id: `pp-res-test-${Date.now()}-tampered`,
});
await summary("3. Tampered signature → 401", await postWebhook(body3, { tamperSig: true }));

// 4. CrossFit reservation → should be filtered
const body4 = reservationBody({
  reservedId: CROSSFIT_CLASS_ID,
  id: `pp-res-test-${Date.now()}-cf`,
});
await summary("4. CrossFit reservation → filtered", await postWebhook(body4));

// 5. Bogus reservedId → getClass should fail
const body5 = reservationBody({
  reservedId: "cal-definitely-does-not-exist",
  id: `pp-res-test-${Date.now()}-bogus`,
});
await summary("5. Bogus class ID → failed", await postWebhook(body5));

// 6. Jimmy John (not in Glofox) — exercises the createLead branch.
//    In Phase A (mock): success.
//    In Phase B (readonly): failed at member_unlinkable, pending_refund row.
//    In Phase C (live): a real Glofox lead gets created for Jimmy John.
const body6 = reservationBody({
  reservedId: SAUNA_CLASS_ID,
  customerId: JIMMY_CUSTOMER_ID,
  id: `pp-res-test-${Date.now()}-jimmy`,
});
await summary("6. Jimmy John (not in Glofox)", await postWebhook(body6));

console.log("\nDone. Next: query event_log to verify rows landed.");

// index.ts top-level calls Deno.serve(), which binds a port. Exit explicitly
// so the script doesn't hang on that listener.
Deno.exit(0);
