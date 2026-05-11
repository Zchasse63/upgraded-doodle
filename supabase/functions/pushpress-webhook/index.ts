// supabase/functions/pushpress-webhook/index.ts
//
// Single entry point for all PushPress webhooks. Dispatches by event name
// to per-event handlers.
//
// Auth: PushPress signs each payload with HMAC-SHA256 over JSON.stringify(body.data)
// using the per-subscription signing secret. See ../_shared/signature.ts.
//
// Idempotency: dedup via SHA-256 of (event, data.id, data.companyId, created)
// stored in event_log with a unique constraint. See ../_shared/dedup.ts.
//
// Q9: PushPress (CC's instance) contains BOTH CrossFit and Sauna activity.
// We filter to mirror only sauna class types to TSG's live Glofox. See
// ../_shared/filter.ts and handlers/reservation-created.ts.
//
// PR 1 only implements reservation.created end-to-end. The other 8 handlers
// remain stubbed as `status: "skipped"`. PR 2 fills them in.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  HandlerResult,
  PushPressEventName,
  PushPressWebhookBody,
} from "../_shared/types.ts";
import { verifyPushPressSignature } from "../_shared/signature.ts";
import { computeDedupKey } from "../_shared/dedup.ts";
import { insertEventLog, updateEventLog } from "../_shared/event-log.ts";
import { glofoxClientFromEnv } from "../_shared/glofox-client.ts";
import type { GlofoxClientShape } from "../_shared/types.ts";
import { PushPressClient } from "../_shared/pushpress-client.ts";
import { handleReservationCreated } from "./handlers/reservation-created.ts";
import { handleEnrollmentCreated } from "./handlers/enrollment-created.ts";

// --- Bootstrapping ----------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUSHPRESS_WEBHOOK_SIGNING_SECRET =
  Deno.env.get("PUSHPRESS_WEBHOOK_SIGNING_SECRET") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — all requests will fail",
    }),
  );
}
if (!PUSHPRESS_WEBHOOK_SIGNING_SECRET) {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "missing PUSHPRESS_WEBHOOK_SIGNING_SECRET — all requests will 401",
    }),
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Lazily memoize the external clients at module scope so their rate-limit
// pacing state is shared across requests in the same Edge Function isolate.
// First-request init means a missing env var surfaces as a per-request
// failure (caught by the dispatcher), not a cold-start crash that 500s every
// inbound webhook. The Glofox client variant is determined by GLOFOX_MODE
// (mock | readonly | live) — see _shared/glofox-client.ts.
let _glofox: GlofoxClientShape | undefined;
let _pushpress: PushPressClient | undefined;

function glofox(): GlofoxClientShape {
  if (!_glofox) _glofox = glofoxClientFromEnv();
  return _glofox;
}

function pushpress(): PushPressClient {
  if (!_pushpress) _pushpress = PushPressClient.fromEnv();
  return _pushpress;
}

// --- Handlers ---------------------------------------------------------------

function skipped(_body: PushPressWebhookBody): Promise<HandlerResult> {
  return Promise.resolve({
    status: "skipped",
    error: "handler not implemented (PR 2)",
  });
}

// Typing this against PushPressEventName means adding or removing a subscribed
// event in types.ts forces a corresponding dispatch-table update.
const HANDLERS: Record<
  PushPressEventName,
  (body: PushPressWebhookBody) => Promise<HandlerResult>
> = {
  "enrollment.created": (body) =>
    handleEnrollmentCreated(body, {
      supabase,
      glofox: glofox(),
      pushpress: pushpress(),
    }),
  "enrollment.status.changed": skipped,
  "enrollment.deleted": skipped,
  "reservation.created": (body) =>
    handleReservationCreated(body, {
      supabase,
      glofox: glofox(),
      pushpress: pushpress(),
    }),
  "reservation.canceled": skipped,
  "reservation.waitlisted": skipped,
  "checkin.created": skipped,
  "class.canceled": skipped,
  "customer.details.changed": skipped,
};

function dispatchHandler(
  event: string,
  body: PushPressWebhookBody,
): Promise<HandlerResult> {
  return event in HANDLERS
    ? HANDLERS[event as PushPressEventName](body)
    : Promise.resolve({
        status: "skipped" as const,
        error: `unknown event: ${event}`,
      });
}

// --- Top-level request handler ---------------------------------------------

// PushPress webhook payloads are small (a few KB at most). Cap inbound size
// to bound memory amplification from a malicious sender flooding large bodies.
const MAX_BODY_BYTES = 64 * 1024;

// Exported so a local test-driver script (scripts/test-drive.ts) can invoke
// the handler in-process. Production: `serve(handleRequest)` below.
export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  // 1. Read body.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", msg: "failed to read body", err: String(err) }),
    );
    return new Response("Bad request", { status: 400 });
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    // Sender lied about content-length or didn't send the header.
    return new Response("Payload too large", { status: 413 });
  }

  // 2. Parse JSON.
  let body: PushPressWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  // 3. Verify signature.
  const providedSignature = req.headers.get("webhook-signature") ?? "";
  const signatureValid = await verifyPushPressSignature(
    body,
    providedSignature,
    PUSHPRESS_WEBHOOK_SIGNING_SECRET,
  );

  if (!signatureValid) {
    // Best-effort audit log of the rejected payload. Don't let a DB outage
    // block the 401 — security takes priority over logging completeness.
    try {
      const dedupKey = await computeDedupKey(body);
      await insertEventLog(supabase, {
        dedupKey,
        event: body.event,
        companyId: pickCompanyId(body),
        signatureVerified: false,
        handlerStatus: "failed",
        handlerError: "invalid_signature",
        payload: body,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "event_log insert for invalid signature failed (continuing to 401)",
          err: String(err),
        }),
      );
    }
    return new Response("Invalid signature", { status: 401 });
  }

  // 4. Dedup key.
  const dedupKey = await computeDedupKey(body);

  // 5. Insert pending event_log row — collision means duplicate delivery.
  let insert: { duplicate: boolean };
  try {
    insert = await insertEventLog(supabase, {
      dedupKey,
      event: body.event,
      companyId: pickCompanyId(body),
      signatureVerified: true,
      handlerStatus: "pending",
      payload: body,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "event_log insert failed",
        event: body.event,
        err: String(err),
      }),
    );
    // Return 200 anyway so PushPress doesn't retry endlessly into a broken DB.
    return ok({ status: "failed", error: "event_log_unavailable" });
  }

  if (insert.duplicate) {
    return ok({ status: "duplicate" });
  }

  // 6. Dispatch.
  const startedAt = Date.now();
  let result: HandlerResult;
  try {
    result = await dispatchHandler(body.event, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        level: "error",
        msg: "handler threw",
        event: body.event,
        err: message,
      }),
    );
    result = { status: "failed", error: message };
  }
  const durationMs = Date.now() - startedAt;

  // 7. Record outcome.
  try {
    await updateEventLog(supabase, dedupKey, {
      handlerStatus: result.status,
      handlerError: result.error,
      durationMs,
      glofoxResponse: result.glofoxResponse,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "event_log update failed — row stuck at 'pending'",
        event: body.event,
        dedup_key: dedupKey,
        err: String(err),
      }),
    );
  }

  // 8. Always 200 — we own retry behavior via event_log, not via PushPress.
  return ok({ status: result.status });
}

// In the Supabase Edge runtime this binds the function's request handler.
// Test-driver scripts that `import { handleRequest }` from this module will
// also bind a port at import time; that's harmless (they call handleRequest
// directly and exit). See scripts/test-drive.ts for the Deno.exit() at end.
Deno.serve(handleRequest);

// --- Helpers ---------------------------------------------------------------

function pickCompanyId(body: PushPressWebhookBody): string | undefined {
  const data = body.data as { companyId?: unknown; company?: unknown };
  if (typeof data.companyId === "string") return data.companyId;
  if (typeof data.company === "string") return data.company; // checkins use `company`
  return undefined;
}

function ok(body: { status: HandlerResult["status"] | "duplicate"; error?: string }): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
