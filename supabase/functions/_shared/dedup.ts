// Idempotency key generation. PushPress's retry policy is undocumented
// (open-questions.md Q2) — assume aggressive retries are possible. We dedup
// by a SHA-256 of (event, data.id, data.companyId, created), stored in
// event_log.dedup_key with a unique constraint.
//
// For the slim enrollment.deleted payload (no companyId), the empty-string
// fallback gives a stable key without special-casing.

import type { PushPressWebhookBody } from "./types.ts";

const ENC = new TextEncoder();

export async function computeDedupKey(body: PushPressWebhookBody): Promise<string> {
  const data = body.data as { id?: unknown; companyId?: unknown };
  const id = typeof data.id === "string" ? data.id : "";
  const companyId = typeof data.companyId === "string" ? data.companyId : "";
  const created = typeof body.created === "number" ? body.created : 0;
  const input = `${body.event}|${id}|${companyId}|${created}`;

  const digest = await crypto.subtle.digest("SHA-256", ENC.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
