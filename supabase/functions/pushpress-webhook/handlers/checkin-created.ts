// Handler for the PushPress `checkin.created` webhook.
//
// Mirrors a class check-in into a Glofox attendance record (`POST /2.0/
// attendances`). Only kind=class && role=attendee && result=success triggers
// the mirror; everything else is filtered.
//
// Read-only mapping lookups: a check-in without a prior reservation.created
// implies either we missed the booking or the member bypassed booking — auto-
// creating a member-link or slot-mapping at check-in time would mask a real
// data-integrity problem. Fail visibly instead.
//
// Quirk: the checkin payload uses `customer` / `company` (not `customerId`
// / `companyId`). The dispatcher's pickCompanyId helper already accounts for
// this; here we read `data.customer` directly.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  HandlerResult,
  PushPressWebhookBody,
} from "../../_shared/types.ts";
import { GlofoxApiError } from "../../_shared/glofox-client.ts";
import { selectMemberLink, selectSlotMapping } from "../../_shared/mappings.ts";
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

  if (!data.customer || !data.classId || typeof data.timestamp !== "number") {
    return {
      status: "failed",
      error: "checkin payload missing customer, classId, or timestamp",
    };
  }

  const memberLink = await selectMemberLink(deps.supabase, data.customer);
  if (!memberLink) {
    return { status: "failed", error: "member_not_linked" };
  }

  const slotMapping = await selectSlotMapping(deps.supabase, data.classId);
  if (!slotMapping) {
    return { status: "failed", error: "slot_not_mapped" };
  }

  try {
    await deps.glofox.markAttendance({
      userId: memberLink.glofoxUserId,
      eventId: slotMapping.glofoxEventId,
      attendedAt: data.timestamp,
    });
    return { status: "success" };
  } catch (err) {
    if (err instanceof GlofoxApiError) {
      if (err.status >= 500) {
        void alertOps(deps.supabase, "checkin.created", {
          reason: "glofox_5xx",
          user_id: memberLink.glofoxUserId,
          event_id: slotMapping.glofoxEventId,
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
