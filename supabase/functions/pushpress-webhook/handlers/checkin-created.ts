// Handler for the PushPress `checkin.created` webhook.
//
// Mirrors a class check-in into a Glofox attendance record (`POST /2.0/
// attendances`). Only kind=class && role=attendee && result=success triggers
// the mirror; everything else is filtered.
//
// Spec-verified shape (2026-05-12 from Glofox OpenAPI):
//   AttendanceRequest = { model: "bookings", model_ids: [bookingId, ...] }
//
// That means attendance is keyed by **Glofox booking_id**, NOT event_id or
// user_id. We need to:
//   1. Find the prior successful `reservation.created` row for this customer
//      and class — that row stores the booking_id in glofox_response
//   2. Mark attendance on that booking_id
//
// Quirk: the checkin payload uses `data.customer` / `data.company` (NOT
// `customerId` / `companyId` like other events). We read `data.customer`
// directly. See docs/pushpress/webhook-events.md.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  HandlerResult,
  PushPressWebhookBody,
} from "../../_shared/types.ts";
import { GlofoxApiError } from "../../_shared/glofox-client.ts";
import { alertOps } from "../../_shared/slack.ts";

export interface CheckinCreatedDeps {
  supabase: SupabaseClient;
  glofox: GlofoxClientShape;
}

export async function handleCheckinCreated(
  body: PushPressWebhookBody,
  deps: CheckinCreatedDeps,
): Promise<HandlerResult> {
  const data = body.data as {
    id?: string;
    customer?: string;
    classId?: string;
    timestamp?: number;
    kind?: string;
    role?: string;
    result?: string;
  };

  if (!data.id) {
    return { status: "failed", error: "checkin payload missing id" };
  }

  if (data.kind !== "class" || data.role !== "attendee" || data.result !== "success") {
    return {
      status: "filtered",
      error: `checkin_filtered:kind=${data.kind};role=${data.role};result=${data.result}`,
    };
  }

  if (!data.customer || !data.classId) {
    return {
      status: "failed",
      error: "checkin payload missing customer or classId",
    };
  }

  // Find the matching prior `reservation.created` success row. We filter on
  // both reservedId (= classId from checkin) AND customerId so multi-user
  // events don't ambiguously match.
  const { data: priorRow, error } = await deps.supabase
    .from("event_log")
    .select("glofox_response, payload")
    .eq("pushpress_event", "reservation.created")
    .eq("handler_status", "success")
    .filter("payload->data->>reservedId", "eq", data.classId)
    .filter("payload->data->>customerId", "eq", data.customer)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { status: "failed", error: `event_log query failed: ${error.message}` };
  }
  if (!priorRow) {
    return {
      status: "failed",
      error: "no_prior_booking_for_this_customer_and_class",
    };
  }
  const bookingId = (priorRow.glofox_response as { bookingId?: string } | null)
    ?.bookingId;
  if (!bookingId) {
    return { status: "failed", error: "prior_booking_missing_bookingId" };
  }

  try {
    await deps.glofox.markAttendance(bookingId);
    return { status: "success", glofoxResponse: { bookingId } };
  } catch (err) {
    if (err instanceof GlofoxApiError) {
      if (err.status >= 500) {
        void alertOps(deps.supabase, "checkin.created", {
          reason: "glofox_5xx",
          booking_id: bookingId,
          status: err.status,
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
