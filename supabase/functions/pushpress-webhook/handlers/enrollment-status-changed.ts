// Handler for the PushPress `enrollment.status.changed` webhook.
//
// Only the cancel transitions (status ∈ {canceled, pendcancel}) trigger a
// Glofox call; other transitions (paused, active, etc.) log + ack since
// Glofox doesn't have a clean equivalent across membership types.
//
// userMembershipId resolution chain (in order):
//   1. pushpress_enrollment_links — populated by enrollment.created going
//      forward; backfilled from event_log for historical rows by migration 0006
//   2. Glofox query fallback — getMemberMemberships(userId) filtered to the
//      expected NOEQL membership_id (recovered from plan_mappings). When a
//      unique match is found, cache it back via updateEnrollmentLink...
//   3. If still ambiguous: skipped (don't guess — wrong cancel would be bad)

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  HandlerResult,
  PushPressWebhookBody,
} from "../../_shared/types.ts";
import { GlofoxApiError } from "../../_shared/glofox-client.ts";
import {
  getEnrollmentLink,
  getPlanMapping,
  lookupMemberMembership,
  selectMemberLink,
} from "../../_shared/mappings.ts";
import { alertOps } from "../../_shared/slack.ts";

export interface EnrollmentStatusChangedDeps {
  supabase: SupabaseClient;
  glofox: GlofoxClientShape;
}

const CANCEL_STATUSES = new Set(["canceled", "pendcancel"]);

export async function handleEnrollmentStatusChanged(
  body: PushPressWebhookBody,
  deps: EnrollmentStatusChangedDeps,
): Promise<HandlerResult> {
  const data = body.data as {
    id?: string;
    customerId?: string;
    status?: string;
    planId?: string;
  };

  if (!data.id || !data.customerId) {
    return {
      status: "failed",
      error: "enrollment payload missing id or customerId",
    };
  }

  if (!data.status || !CANCEL_STATUSES.has(data.status)) {
    return {
      status: "skipped",
      error: `non_cancel_transition:${data.status ?? "<missing>"}`,
    };
  }

  // Look up cached userMembershipId.
  const link = await getEnrollmentLink(deps.supabase, data.id);

  let userMembershipId: string | null = link?.glofoxUserMembershipId ?? null;

  // Fallback: query Glofox for the user's memberships, find the one
  // matching the expected NOEQL membership_id.
  if (!userMembershipId) {
    const memberLink = await selectMemberLink(deps.supabase, data.customerId);
    if (!memberLink) {
      return { status: "failed", error: "member_not_linked" };
    }
    if (!data.planId) {
      return { status: "failed", error: "missing_planId_cannot_resolve_membership" };
    }
    const plan = await getPlanMapping(deps.supabase, data.planId);
    if (!plan) {
      return { status: "failed", error: `unmapped_plan:${data.planId}` };
    }
    userMembershipId = await lookupMemberMembership(
      deps.glofox,
      deps.supabase,
      memberLink.glofoxUserId,
      data.id,
      plan.glofoxMembershipId,
    );
    if (!userMembershipId) {
      // Don't cancel something we can't uniquely identify.
      return {
        status: "skipped",
        error: "membership_not_uniquely_identified_in_glofox",
      };
    }
  }

  try {
    await deps.glofox.cancelMembership(userMembershipId);
    return {
      status: "success",
      glofoxResponse: { userMembershipId, transition: data.status },
    };
  } catch (err) {
    if (err instanceof GlofoxApiError) {
      if (err.status >= 500) {
        void alertOps(deps.supabase, "enrollment.status.changed", {
          reason: "glofox_5xx_on_cancel",
          user_membership_id: userMembershipId,
          status: err.status,
          error: err.message,
        });
      }
      return {
        status: "failed",
        error: err.message,
        glofoxResponse: {
          userMembershipId,
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
