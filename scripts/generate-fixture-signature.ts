// Compute the HMAC-SHA256 signature for a webhook fixture's `data` field.
// Mirrors the PushPress SDK's webhook-security-custom.ts math exactly.
//
// Usage:
//   deno run --allow-read --allow-env scripts/generate-fixture-signature.ts \
//     <path-to-fixture.json> <signing-secret>
//
// Or pass the secret via env:
//   PUSHPRESS_WEBHOOK_SIGNING_SECRET=... \
//     deno run --allow-read --allow-env scripts/generate-fixture-signature.ts <fixture>
//
// Prints the lowercase hex signature to stdout. Pipe to a .signature.txt file
// alongside the fixture JSON, or use it as the value of the `webhook-signature`
// header in a curl test.

if (Deno.args.length < 1) {
  console.error(
    "usage: generate-fixture-signature.ts <fixture.json> [signing-secret]",
  );
  Deno.exit(1);
}

const fixturePath = Deno.args[0];
const secret =
  Deno.args[1] ?? Deno.env.get("PUSHPRESS_WEBHOOK_SIGNING_SECRET") ?? "";

if (!secret) {
  console.error(
    "error: signing secret required as second arg or PUSHPRESS_WEBHOOK_SIGNING_SECRET env var",
  );
  Deno.exit(1);
}

const text = await Deno.readTextFile(fixturePath);
let body: { data: unknown };
try {
  body = JSON.parse(text);
} catch (err) {
  console.error(`error: ${fixturePath} is not valid JSON: ${err}`);
  Deno.exit(1);
}

if (typeof body !== "object" || body === null || !("data" in body)) {
  console.error(`error: ${fixturePath} must have a top-level 'data' field`);
  Deno.exit(1);
}

const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);

const sigBytes = await crypto.subtle.sign(
  "HMAC",
  key,
  new TextEncoder().encode(JSON.stringify(body.data)),
);

const hex = Array.from(new Uint8Array(sigBytes))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

console.log(hex);
