// Handler for the PushPress `reservation.created` webhook.
//
// Step-by-step (see docs/pr-1-architecture.md § 7):
//   1. Guard: data.customerId must exist.
//   2. Fetch the PushPress class to get classTypeName + start.
//   3. Filter: if classTypeName is not in the sauna allowlist, return
//      'filtered' (this is a CrossFit reservation we deliberately do NOT
//      mirror to TSG's live Glofox).
//   4. Resolve PushPress customer → Glofox user (member_link cache, fallback
//      to email match or auto-create-lead).
//   5. Resolve PushPress calendar item → Glofox event (slot_mapping cache,
//      fallback to time-window query).
//   6. Create the Glofox booking with charge:false, pay_gym:false.
//      On capacity error → enqueue pending_refunds (capacity_full).
//   7. Return success with the new Glofox booking ID.

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

export interface ReservationCreatedDeps {
  supabase: SupabaseClient;
  glofox: GlofoxClientShape;
  pushpress: PushPressClient;
}

export async function handleReservationCreated(
  body: PushPressWebhookBody,
  deps: ReservationCreatedDeps,
): Promise<HandlerResult> {
  const data = body.data as {
    id?: string;
    reservedId?: string;
    customerId?: string;
  };

  // --- 1. Guards ----------------------------------------------------------
  if (!data.id || !data.reservedId || !data.customerId) {
    return {
      status: "failed",
      error: "reservation payload missing required fields (id, reservedId, customerId)",
    };
  }

  // --- 2. Resolve the PushPress class for classTypeName + start ----------
  let ppClass: { classTypeName?: string | null; start: number };
  try {
    ppClass = await deps.pushpress.getClass(data.reservedId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      error: `pushpress.getClass failed: ${message}`,
    };
  }

  // --- 3. Q9 sauna filter -------------------------------------------------
  if (!isSaunaClassType(ppClass.classTypeName)) {
    return {
      status: "filtered",
      error: `class_type_not_in_allowlist:${ppClass.classTypeName ?? "<null>"}`,
    };
  }

  // --- 4. Resolve PushPress customer → Glofox user ------------------------
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

  // --- 5. Resolve PushPress calendar item → Glofox event ------------------
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

  // --- 6. Mirror the booking to Glofox -----------------------------------
  try {
    const booking = await deps.glofox.createBooking({
      userId: memberLink.glofoxUserId,
      eventId: slotMapping.glofoxEventId,
    });
    return {
      status: "success",
      glofoxResponse: { bookingId: booking._id },
    };
  } catch (err) {
    if (err instanceof GlofoxCapacityError) {
      await enqueuePendingRefund(deps.supabase, {
        reservationId: data.id,
        customerId: data.customerId,
        calendarItemId: data.reservedId,
        reason: "capacity_full",
        glofoxError: err.message,
      });
      return {
        status: "failed",
        error: "capacity_full",
        glofoxResponse: { error: err.message },
      };
    }

    if (err instanceof GlofoxApiError) {
      // 5xx or unexpected 4xx — log; don't enqueue pending_refund automatically
      // since the customer wasn't necessarily charged in PushPress yet.
      return {
        status: "failed",
        error: err.message,
        glofoxResponse: { error: err.message, status: err.status },
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", error: message };
  }
}
