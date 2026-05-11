// Handler for the PushPress `enrollment.deleted` webhook.
//
// PushPress docstring: "Enrollment deleted, most often because of a failed
// initial payment." Treat as hard cancel — same cancel call as a normal cancel.
//
// Slim payload: only `{id}`. NO customerId. So if pushpress_enrollment_links
// doesn't have a userMembershipId for this enrollment, we CAN'T do the Glofox
// fallback (it requires the Glofox user_id, which requires customerId).
// In that case, return skipped — historical enrollments that pre-date the
// bridge are silently un-cancellable. Ops should monitor for spikes.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  HandlerResult,
  PushPressWebhookBody,
} from "../../_shared/types.ts";
import { GlofoxApiError } from "../../_shared/glofox-client.ts";
import { getEnrollmentLink } from "../../_shared/mappings.ts";
import { alertOps } from "../../_shared/slack.ts";

export interface EnrollmentDeletedDeps {
  supabase: SupabaseClient;
  glofox: GlofoxClientShape;
}

export async function handleEnrollmentDeleted(
  body: PushPressWebhookBody,
  deps: EnrollmentDeletedDeps,
): Promise<HandlerResult> {
  const data = body.data as { id?: string };

  if (!data.id) {
    return { status: "failed", error: "enrollment payload missing id" };
  }

  const link = await getEnrollmentLink(deps.supabase, data.id);
  if (!link) {
    return {
      status: "skipped",
      error: "no_enrollment_link_for_deleted_id",
    };
  }
  if (!link.glofoxUserMembershipId) {
    // Backfilled row from 0006 with NULL userMembershipId (DQ7). No
    // customerId available here for fallback. Cancel handler for the
    // status.changed path is the canonical recovery mechanism — this one
    // skips cleanly.
    return {
      status: "skipped",
      error: "membership_id_unknown_cannot_cancel",
    };
  }

  try {
    await deps.glofox.cancelMembership(link.glofoxUserMembershipId);
    return {
      status: "success",
      glofoxResponse: { userMembershipId: link.glofoxUserMembershipId },
    };
  } catch (err) {
    if (err instanceof GlofoxApiError) {
      if (err.status >= 500) {
        await alertOps(deps.supabase, "enrollment.deleted", {
          reason: "glofox_5xx_on_cancel",
          user_membership_id: link.glofoxUserMembershipId,
          status: err.status,
          error: err.message,
        });
      }
      return {
        status: "failed",
        error: err.message,
        glofoxResponse: {
          userMembershipId: link.glofoxUserMembershipId,
          error: err.message,
          status: err.status,
        },
      };
    }
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
