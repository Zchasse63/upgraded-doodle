// Handler for the PushPress `class.canceled` webhook.
//
// Fan-out: when CC cancels a sauna class entirely, every prior reservation
// for that class needs its Glofox booking cancelled. We query event_log for
// all successful `reservation.created` rows whose `payload.data.reservedId`
// matches this class id, then DELETE each Glofox booking sequentially.
//
// Sequential (not parallel) by design: GlofoxClient.pace() enforces 200ms
// between calls from the same client instance. Parallel fan-out at any
// concurrency > 1 would exceed Glofox's 10 RPS rate limit. For the typical
// 6 bookings per class, sequential = ~1.2s total — fine for a rare event.
//
// Per-booking failure isolation: each DELETE is in its own try/catch. A
// failure on booking N does not prevent booking N+1 from being attempted.
// Failures are written to pending_refunds for ops follow-up.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  HandlerResult,
  PushPressWebhookBody,
} from "../../_shared/types.ts";
import { GlofoxApiError } from "../../_shared/glofox-client.ts";
import { enqueuePendingRefund } from "../../_shared/mappings.ts";
import { alertOps } from "../../_shared/slack.ts";

export interface ClassCanceledDeps {
  supabase: SupabaseClient;
  glofox: GlofoxClientShape;
}

interface BookingResult {
  bookingId: string;
  reservationId: string;
  customerId: string | null;
  ok: boolean;
  error?: string;
}

export async function handleClassCanceled(
  body: PushPressWebhookBody,
  deps: ClassCanceledDeps,
): Promise<HandlerResult> {
  const data = body.data as { id?: string };

  if (!data.id) {
    return { status: "failed", error: "class payload missing id" };
  }

  // Find every successful reservation.created for this class.
  // We need bookingId (from glofox_response), reservationId + customerId
  // (from payload) so we can write a pending_refund per failure.
  const { data: priorRows, error } = await deps.supabase
    .from("event_log")
    .select("payload, glofox_response")
    .eq("pushpress_event", "reservation.created")
    .eq("handler_status", "success")
    .filter("payload->data->>reservedId", "eq", data.id);

  if (error) {
    return { status: "failed", error: `event_log query failed: ${error.message}` };
  }

  const targets: Array<{
    bookingId: string;
    reservationId: string;
    customerId: string | null;
  }> = [];
  for (const row of priorRows ?? []) {
    const payload = (row.payload as { data?: Record<string, unknown> } | null)?.data ??
      {};
    const reservationId = typeof payload.id === "string" ? payload.id : null;
    const customerId = typeof payload.customerId === "string" ? payload.customerId : null;
    const bookingId = (row.glofox_response as { bookingId?: string } | null)?.bookingId;
    if (!reservationId || !bookingId) continue;
    targets.push({ bookingId, reservationId, customerId });
  }

  if (targets.length === 0) {
    return { status: "skipped", error: "no_bookings_to_cancel" };
  }

  // Sequential fan-out. Each iteration awaits before the next starts —
  // pace() inside the client adds the 200ms gap automatically.
  const results: BookingResult[] = [];
  for (const t of targets) {
    try {
      await deps.glofox.cancelBooking(t.bookingId);
      results.push({
        bookingId: t.bookingId,
        reservationId: t.reservationId,
        customerId: t.customerId,
        ok: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        bookingId: t.bookingId,
        reservationId: t.reservationId,
        customerId: t.customerId,
        ok: false,
        error: message,
      });
      // Enqueue a pending_refund per failed booking — customerId may be
      // null on very old rows; skip the enqueue in that case (ops can find
      // the booking via event_log).
      if (t.customerId) {
        try {
          await enqueuePendingRefund(deps.supabase, {
            reservationId: t.reservationId,
            customerId: t.customerId,
            calendarItemId: data.id,
            reason: "class_cancel_glofox_failed",
            glofoxError: message,
          });
        } catch (refundErr) {
          console.error(JSON.stringify({
            level: "warn",
            msg: "enqueuePendingRefund failed during class.canceled fan-out",
            err: refundErr instanceof Error ? refundErr.message : String(refundErr),
          }));
        }
      }
      // Alert on 5xx; capacity / 4xx are also worth alerting since this
      // is the cancel path and any failure here = stuck data.
      if (err instanceof GlofoxApiError) {
        void alertOps(deps.supabase, "class.canceled", {
          reason: "booking_delete_failed",
          booking_id: t.bookingId,
          reservation_id: t.reservationId,
          status: err.status,
          error: err.message,
        });
      }
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const status: "success" | "failed" = failed > 0 ? "failed" : "success";

  return {
    status,
    error: failed > 0 ? `${failed}_of_${results.length}_failed` : undefined,
    glofoxResponse: { total: results.length, succeeded, failed, results },
  };
}
