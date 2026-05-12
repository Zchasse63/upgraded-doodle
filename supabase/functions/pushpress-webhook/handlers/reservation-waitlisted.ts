// Handler for the PushPress `reservation.waitlisted` webhook.
//
// Same resolution chain as reservation.created (member → slot → Glofox) but
// calls createBookingWaitlisted instead of createBooking. The Glofox call
// adds `status: "WAITING"` to the bookings POST body.
//
// OQ-1: Glofox waitlist semantics are unverified end-to-end. If the
// GLOFOX_WAITLIST_VERIFIED env var is not set to "true", we deploy the
// handler but skip the actual Glofox call — this gates the feature behind
// an explicit opt-in once TSG ops confirms the waitlist flow against the
// live API. event_log captures the would-have-been booking attempt for ops.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  HandlerResult,
  PushPressWebhookBody,
} from "../../_shared/types.ts";
import {
  GlofoxApiError,
  GlofoxCapacityError,
} from "../../_shared/glofox-client.ts";
import type { PushPressClient } from "../../_shared/pushpress-client.ts";
import { isSaunaClassType } from "../../_shared/filter.ts";
import {
  enqueuePendingRefund,
  getOrCreateMemberLink,
  getOrResolveSlotMapping,
} from "../../_shared/mappings.ts";
import { alertOps } from "../../_shared/slack.ts";

export interface ReservationWaitlistedDeps {
  supabase: SupabaseClient;
  glofox: GlofoxClientShape;
  pushpress: PushPressClient;
}

export async function handleReservationWaitlisted(
  body: PushPressWebhookBody,
  deps: ReservationWaitlistedDeps,
): Promise<HandlerResult> {
  const data = body.data as {
    id?: string;
    reservedId?: string;
    customerId?: string;
  };

  if (!data.id || !data.reservedId || !data.customerId) {
    return {
      status: "failed",
      error: "waitlist payload missing required fields (id, reservedId, customerId)",
    };
  }

  // Gate behind GLOFOX_WAITLIST_VERIFIED until OQ-1 is resolved.
  if (Deno.env.get("GLOFOX_WAITLIST_VERIFIED") !== "true") {
    return {
      status: "skipped",
      error: "waitlist_field_unverified_set_GLOFOX_WAITLIST_VERIFIED_to_enable",
    };
  }

  let ppClass: { classTypeName?: string | null; start: number };
  try {
    ppClass = await deps.pushpress.getClass(data.reservedId);
  } catch (err) {
    return {
      status: "failed",
      error: `pushpress.getClass failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isSaunaClassType(ppClass.classTypeName)) {
    return {
      status: "filtered",
      error: `class_type_not_in_allowlist:${ppClass.classTypeName ?? "<null>"}`,
    };
  }

  let memberLink: { glofoxUserId: string };
  try {
    memberLink = await getOrCreateMemberLink(
      deps.supabase,
      deps.glofox,
      deps.pushpress,
      data.customerId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await enqueuePendingRefund(deps.supabase, {
      reservationId: data.id,
      customerId: data.customerId,
      calendarItemId: data.reservedId,
      reason: "member_unlinkable",
      glofoxError: message,
    });
    return { status: "failed", error: `member_unlinkable: ${message}` };
  }

  const slotMapping = await getOrResolveSlotMapping(
    deps.supabase,
    deps.glofox,
    data.reservedId,
    ppClass.start,
    ppClass.classTypeName ?? null,
  );

  if (!slotMapping) {
    await enqueuePendingRefund(deps.supabase, {
      reservationId: data.id,
      customerId: data.customerId,
      calendarItemId: data.reservedId,
      reason: "slot_unmappable",
    });
    return { status: "failed", error: "slot_unmappable" };
  }

  try {
    const booking = await deps.glofox.createBookingWaitlisted({
      userId: memberLink.glofoxUserId,
      eventId: slotMapping.glofoxEventId,
    });
    return {
      status: "success",
      glofoxResponse: { bookingId: booking._id, waitlist: true },
    };
  } catch (err) {
    if (err instanceof GlofoxCapacityError) {
      // Waitlist hitting capacity error is unusual — the whole point of
      // waitlist is to bypass capacity. Treat same as the created path
      // but flag it as unusual in the alert.
      await enqueuePendingRefund(deps.supabase, {
        reservationId: data.id,
        customerId: data.customerId,
        calendarItemId: data.reservedId,
        reason: "capacity_full",
        glofoxError: err.message,
      });
      void alertOps(deps.supabase, "reservation.waitlisted", {
        reason: "waitlist_capacity_error_unexpected",
        booking_target: slotMapping.glofoxEventId,
        error: err.message,
      });
      return {
        status: "failed",
        error: "capacity_full",
        glofoxResponse: { error: err.message },
      };
    }
    if (err instanceof GlofoxApiError) {
      if (err.status >= 500) {
        void alertOps(deps.supabase, "reservation.waitlisted", {
          reason: "glofox_5xx",
          status: err.status,
          error: err.message,
        });
      }
      return {
        status: "failed",
        error: err.message,
        glofoxResponse: { error: err.message, status: err.status },
      };
    }
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
