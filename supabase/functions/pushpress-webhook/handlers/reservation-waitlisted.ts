// Handler for the PushPress `reservation.waitlisted` webhook.
//
// Same resolution chain as reservation.created (member → slot → Glofox) but
// passes `joinWaitingList: true` to createBooking so Glofox treats the call
// as a waitlist add. The Glofox spec (verified 2026-05-12) says to pass
// `join_waiting_list: true` ONLY when the class is full — when the bridge
// hears `reservation.waitlisted` from PushPress, that's exactly the case
// (the class was full at PushPress-time, so it should be at Glofox-time too).
//
// Response: `Booking.status` will be `"WAITING"` instead of `"BOOKED"`;
// we return that in glofoxResponse so the cancel handler (later) can find
// and DELETE the same booking record whether it's a waitlist or confirmed.

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
    const booking = await deps.glofox.createBooking({
      userId: memberLink.glofoxUserId,
      eventId: slotMapping.glofoxEventId,
      joinWaitingList: true,
    });
    return {
      status: "success",
      glofoxResponse: { bookingId: booking._id, status: booking.status, waitlist: true },
    };
  } catch (err) {
    if (err instanceof GlofoxCapacityError) {
      // WAITING_LIST_IS_FULL falls through to here. Surface it for ops.
      await enqueuePendingRefund(deps.supabase, {
        reservationId: data.id,
        customerId: data.customerId,
        calendarItemId: data.reservedId,
        reason: "capacity_full",
        glofoxError: err.message,
      });
      void alertOps(deps.supabase, "reservation.waitlisted", {
        reason: "waitlist_full_or_capacity",
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
