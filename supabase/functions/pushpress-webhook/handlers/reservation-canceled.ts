// Handler for the PushPress `reservation.canceled` webhook.
//
// Looks up the Glofox booking_id stored on the matching `reservation.created`
// row (which records `glofox_response.bookingId` on success), then DELETEs the
// Glofox booking. Glofox's DELETE is idempotent — a 404 is treated as success
// inside cancelBooking().
//
// Out-of-order handling: if the cancel arrives before the create has been
// processed (or the create failed), there's nothing to cancel. Return skipped
// with a clear reason so the audit log shows what happened.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  HandlerResult,
  PushPressWebhookBody,
} from "../../_shared/types.ts";
import { GlofoxApiError } from "../../_shared/glofox-client.ts";
import { alertOps } from "../../_shared/slack.ts";

export interface ReservationCanceledDeps {
  supabase: SupabaseClient;
  glofox: GlofoxClientShape;
}

export async function handleReservationCanceled(
  body: PushPressWebhookBody,
  deps: ReservationCanceledDeps,
): Promise<HandlerResult> {
  const data = body.data as { id?: string };

  if (!data.id) {
    return { status: "failed", error: "reservation payload missing id" };
  }

  // Find the prior successful reservation.created for this reservation id.
  const { data: priorRow, error } = await deps.supabase
    .from("event_log")
    .select("glofox_response")
    .eq("pushpress_event", "reservation.created")
    .eq("handler_status", "success")
    .filter("payload->data->>id", "eq", data.id)
    .limit(1)
    .maybeSingle();

  if (error) {
    return { status: "failed", error: `event_log query failed: ${error.message}` };
  }

  if (!priorRow) {
    // Out-of-order delivery, or the original create failed. Either way,
    // nothing to cancel on the Glofox side.
    return { status: "skipped", error: "no_prior_booking_found" };
  }

  const bookingId = (priorRow.glofox_response as { bookingId?: string } | null)
    ?.bookingId;
  if (!bookingId) {
    return { status: "skipped", error: "prior_booking_missing_bookingId" };
  }

  try {
    await deps.glofox.cancelBooking(bookingId);
    return { status: "success", glofoxResponse: { bookingId } };
  } catch (err) {
    if (err instanceof GlofoxApiError) {
      if (err.status >= 500) {
        await alertOps(deps.supabase, "reservation.canceled", {
          reason: "glofox_5xx",
          booking_id: bookingId,
          error: err.message,
        });
      }
      return {
        status: "failed",
        error: err.message,
        glofoxResponse: { bookingId, error: err.message, status: err.status },
      };
    }
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
