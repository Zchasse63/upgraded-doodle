// One-shot script to create a PushPress webhook subscription.
//
// Usage:
//   deno run --allow-net --allow-env scripts/setup-webhook.ts <edge-function-url>
//
// Example:
//   deno run --allow-net --allow-env scripts/setup-webhook.ts \
//     https://abcd.supabase.co/functions/v1/pushpress-webhook
//
// Reads from env: PUSHPRESS_API_KEY, PUSHPRESS_COMPANY_ID, PUSHPRESS_SERVER
// (production | staging | development; defaults to production).
//
// Prints the full JSON response to stdout. The `signingSecret` field is
// returned EXACTLY ONCE — copy it immediately to:
//   .env.local                          (for local function runs)
//   supabase secrets set PUSHPRESS_WEBHOOK_SIGNING_SECRET=...
//                                       (for deployed function)
//
// If the secret is lost, use the rotate-signing-secret endpoint to get a
// new one — the old one cannot be recovered.
//
// This script does NOT use the @pushpress/pushpress SDK. The SDK is alpha
// and a local one-shot tool calling a single endpoint doesn't warrant the
// dependency.

const EVENT_TYPES = [
  "enrollment.created",
  "enrollment.status.changed",
  "enrollment.deleted",
  "reservation.created",
  "reservation.canceled",
  "reservation.waitlisted",
  "checkin.created",
  "class.canceled",
  "customer.details.changed",
];

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  Deno.exit(1);
}

const edgeFunctionUrl = Deno.args[0];
if (!edgeFunctionUrl) {
  fail("usage: setup-webhook.ts <edge-function-url>");
}
try {
  new URL(edgeFunctionUrl);
} catch {
  fail(`invalid URL: ${edgeFunctionUrl}`);
}

const apiKey = Deno.env.get("PUSHPRESS_API_KEY");
const companyId = Deno.env.get("PUSHPRESS_COMPANY_ID");
if (!apiKey) fail("PUSHPRESS_API_KEY is not set");
if (!companyId) fail("PUSHPRESS_COMPANY_ID is not set");

const server = Deno.env.get("PUSHPRESS_SERVER") ?? "production";
const baseUrl =
  server === "staging"
    ? "https://api.pushpressstage.com/v3"
    : server === "development"
    ? "https://api.pushpressdev.com/v3"
    : "https://api.pushpress.com/v3";

const res = await fetch(`${baseUrl}/webhooks`, {
  method: "POST",
  headers: {
    "API-KEY": apiKey,
    "company-id": companyId,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url: edgeFunctionUrl,
    eventTypes: EVENT_TYPES,
  }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`PushPress returned ${res.status}:`);
  console.error(text);
  Deno.exit(1);
}

interface CreateWebhookResponse {
  signingSecret?: string;
  [k: string]: unknown;
}

let json: CreateWebhookResponse;
try {
  json = JSON.parse(text);
} catch {
  console.error("non-JSON response from PushPress:");
  console.error(text);
  Deno.exit(1);
}

// Print the metadata to stdout with the secret redacted, so that pipelines /
// shell history / log captures don't accidentally persist the secret. The
// raw signingSecret goes to stderr, separated, with no prefix that could be
// confused for a structured log line.
const redacted = { ...json };
if (typeof redacted.signingSecret === "string") {
  redacted.signingSecret = "<printed to stderr only — see below>";
}
console.log(JSON.stringify(redacted, null, 2));

if (typeof json.signingSecret !== "string") {
  console.error("warning: response did not include a signingSecret field");
  Deno.exit(1);
}

console.error("");
console.error("=".repeat(72));
console.error("  PUSHPRESS_WEBHOOK_SIGNING_SECRET");
console.error("=".repeat(72));
console.error(json.signingSecret);
console.error("=".repeat(72));
console.error("  Save this to .env.local AND supabase secrets set NOW.");
console.error("  It will not be returned again — only rotated.");
console.error("=".repeat(72));
