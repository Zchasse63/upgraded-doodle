// supabase/functions/pushpress-webhook/index.ts
//
// Single entry point for all PushPress webhooks. Dispatches by event name
// to per-event handlers.
//
// STATUS: SCAFFOLD ONLY. No business logic. PR 1 in the next session fills
// these handlers in following the architect → implement → review pipeline.
// See ../../docs/pr-1-plan.md.
//
// Auth: PushPress signs each payload with HMAC-SHA256 over JSON.stringify(body.data)
// using the per-subscription signing secret. We verify with the same math.
// See ../../docs/pushpress/sdk-reference.md § Webhooks.
//
// Idempotency: PushPress retries are undocumented. We dedup via SHA-256 of
// {event, data.id, data.companyId, created} stored in event_log.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// -----------------------------------------------------------------------------
// Types — these will move into _shared/types.ts in PR 1
// -----------------------------------------------------------------------------

type PushPressEventName =
  | "enrollment.created"
  | "enrollment.status.changed"
  | "enrollment.deleted"
  | "reservation.created"
  | "reservation.canceled"
  | "reservation.waitlisted"
  | "checkin.created"
  | "class.canceled"
  | "customer.details.changed";

interface PushPressWebhookBody {
  event: PushPressEventName;
  created: number; // Unix seconds
  data: Record<string, unknown>;
}

interface HandlerResult {
  status: "success" | "failed" | "skipped";
  error?: string;
  glofoxResponse?: unknown;
}

// -----------------------------------------------------------------------------
// Bootstrapping
// -----------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUSHPRESS_WEBHOOK_SIGNING_SECRET = Deno.env.get("PUSHPRESS_WEBHOOK_SIGNING_SECRET") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Logged at boot, will fail fast on any request.
  console.error("[boot] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
if (!PUSHPRESS_WEBHOOK_SIGNING_SECRET) {
  console.error("[boot] missing PUSHPRESS_WEBHOOK_SIGNING_SECRET — all requests will 401");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -----------------------------------------------------------------------------
// Signature verification — mirrors the SDK's `webhook-security-custom.ts`
// -----------------------------------------------------------------------------

async function verifySignature(rawBody: string, providedSignature: string): Promise<boolean> {
  // TODO(PR1): implement HMAC-SHA256 over JSON.stringify(body.data) and constant-time compare
  // Reference: docs/pushpress/sdk-reference.md § Webhooks
  console.error("[verifySignature] not implemented");
  return false;
}

// -----------------------------------------------------------------------------
// Idempotency
// -----------------------------------------------------------------------------

async function dedupKey(body: PushPressWebhookBody): Promise<string> {
  // TODO(PR1): SHA-256 of `${event}|${data.id}|${data.companyId}|${created}`
  return "";
}

// -----------------------------------------------------------------------------
// Per-event handlers — all TODO. PR 1 implements these.
// -----------------------------------------------------------------------------

async function handleEnrollmentCreated(body: PushPressWebhookBody): Promise<HandlerResult> {
  // 1. Resolve PushPress customer → Glofox user (members_link)
  // 2. If not in members_link: POST /v3.0/namespaces/members/retrieve, fallback to POST /2.1/branches/{id}/leads
  // 3. Look up plan_mappings for PushPress planId → Glofox membership_id + plan_code + payment_method
  // 4. POST /2.2/branches/{branch}/users/{userId}/memberships/{membershipId}/plans/{planCode}/purchase
  //    with payment_method from the mapping (externally-billed)
  // 5. Store the resulting userMembershipId for later cancel reference
  return { status: "skipped", error: "handler not implemented" };
}

async function handleEnrollmentStatusChanged(body: PushPressWebhookBody): Promise<HandlerResult> {
  // If status becomes 'canceled' → POST /v3.0/memberships/{userMembershipId}/cancel
  return { status: "skipped", error: "handler not implemented" };
}

async function handleEnrollmentDeleted(body: PushPressWebhookBody): Promise<HandlerResult> {
  // POST /v3.0/memberships/{userMembershipId}/cancel
  return { status: "skipped", error: "handler not implemented" };
}

async function handleReservationCreated(body: PushPressWebhookBody): Promise<HandlerResult> {
  // 1. Lazy resolve Glofox event_id from slot_mappings, falling back to
  //    GET /2.0/events?date_from=...&date_to=... and caching
  // 2. POST /2.3/branches/{branch}/bookings with charge:false, pay_gym:false
  // 3. On capacity error → enqueue to pending_refunds + send PushPress push + Slack alert
  return { status: "skipped", error: "handler not implemented" };
}

async function handleReservationCanceled(body: PushPressWebhookBody): Promise<HandlerResult> {
  // DELETE /2.3/branches/{branch}/bookings/{bookingId}
  return { status: "skipped", error: "handler not implemented" };
}

async function handleReservationWaitlisted(body: PushPressWebhookBody): Promise<HandlerResult> {
  // POST /2.3/branches/{branch}/bookings with status WAITING
  return { status: "skipped", error: "handler not implemented" };
}

async function handleCheckinCreated(body: PushPressWebhookBody): Promise<HandlerResult> {
  // POST /2.0/attendances
  return { status: "skipped", error: "handler not implemented" };
}

async function handleClassCanceled(body: PushPressWebhookBody): Promise<HandlerResult> {
  // Fan-out DELETE /2.3/branches/{branch}/bookings/{bookingId} for every linked booking
  return { status: "skipped", error: "handler not implemented" };
}

async function handleCustomerDetailsChanged(body: PushPressWebhookBody): Promise<HandlerResult> {
  // Debounced PUT /2.0/members/{userId} — debouncing happens at the queue layer (PR 2)
  return { status: "skipped", error: "handler not implemented" };
}

const HANDLERS: Record<PushPressEventName, (body: PushPressWebhookBody) => Promise<HandlerResult>> = {
  "enrollment.created": handleEnrollmentCreated,
  "enrollment.status.changed": handleEnrollmentStatusChanged,
  "enrollment.deleted": handleEnrollmentDeleted,
  "reservation.created": handleReservationCreated,
  "reservation.canceled": handleReservationCanceled,
  "reservation.waitlisted": handleReservationWaitlisted,
  "checkin.created": handleCheckinCreated,
  "class.canceled": handleClassCanceled,
  "customer.details.changed": handleCustomerDetailsChanged,
};

// -----------------------------------------------------------------------------
// Top-level request handler
// -----------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const startedAt = Date.now();
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    console.error("[webhook] failed to read body", err);
    return new Response("Bad request", { status: 400 });
  }

  const signature = req.headers.get("webhook-signature") ?? "";
  const signatureValid = await verifySignature(rawBody, signature);
  if (!signatureValid) {
    // TODO(PR1): record signature failure in event_log + alert ops
    return new Response("Invalid signature", { status: 401 });
  }

  let body: PushPressWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const handler = HANDLERS[body.event];
  if (!handler) {
    // Unhandled event — record but ack so PushPress doesn't retry forever.
    console.error("[webhook] unhandled event", body.event);
    // TODO(PR1): record to event_log with status='skipped'
    return new Response("OK (unhandled event recorded)", { status: 200 });
  }

  // TODO(PR1): idempotency check against event_log via dedup_key
  // TODO(PR1): wrap handler call in event_log INSERT for audit + outcome
  const result = await handler(body);
  const _durationMs = Date.now() - startedAt;

  return new Response(JSON.stringify({ ok: true, status: result.status }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
