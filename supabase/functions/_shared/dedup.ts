// Idempotency key generation. PushPress's retry policy is undocumented
// (open-questions.md Q2) — assume aggressive retries are possible. We dedup
// by a SHA-256 of (event, data.id, data.companyId, created), stored in
// event_log.dedup_key with a unique constraint.
//
// For the slim enrollment.deleted payload (no companyId), the empty-string
// fallback gives a stable key without special-casing.
//
// SECURITY: when `created` is missing/non-numeric, fall back to a NEGATIVE
// sentinel that varies per (event, id, companyId) tuple rather than the
// previous shared `0` constant. With the old 0-fallback, an attacker who
// captured one signed payload could craft a follow-up by stripping `created`,
// which would collide with the original's dedup_key and silently suppress a
// legitimate future event for that same resource. The tuple-derived sentinel
// makes such collisions infeasible without also forging the signature (which
// HMAC verification already blocks).

import type { PushPressWebhookBody } from "./types.ts";

const ENC = new TextEncoder();

export async function computeDedupKey(body: PushPressWebhookBody): Promise<string> {
  const data = body.data as { id?: unknown; companyId?: unknown };
  const id = typeof data.id === "string" ? data.id : "";
  const companyId = typeof data.companyId === "string" ? data.companyId : "";

  let createdToken: string;
  if (typeof body.created === "number" && Number.isFinite(body.created)) {
    createdToken = String(body.created);
  } else {
    // Synthesize a stable-but-collision-resistant fallback so a missing
    // `created` field can't be used to suppress legitimate future events.
    createdToken = `MISSING_CREATED:${body.event}:${id}:${companyId}`;
  }

  const input = `${body.event}|${id}|${companyId}|${createdToken}`;
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
