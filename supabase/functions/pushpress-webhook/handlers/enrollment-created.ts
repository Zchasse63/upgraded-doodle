// Handler for the PushPress `enrollment.created` webhook.
//
// Mirrors a CC member's new sauna plan into a Glofox NOEQL membership so the
// member becomes eligible to book sauna classes in Glofox.
//
// Step-by-step (see docs/pr-2-architecture.md § Handler flow):
//   1. Guard: data.id + data.customerId + data.planId all required.
//   2. Fetch the PushPress plan to get category.name.
//   3. Filter: if plan.category.name is not in the sauna allowlist, return
//      'filtered' (this is a CrossFit-side enrollment we deliberately do NOT
//      mirror to Glofox).
//   4. Look up plan_mappings for the Glofox membership_id + plan_code + promo.
//      No mapping = ops config gap → 'failed' with error='unmapped_plan:<id>'.
//   5. Resolve PushPress customer → Glofox user (members_link cache, fallback
//      to email match or auto-create-lead).
//   6. POST Glofox /2.2/.../purchase with the mapping's payment_method + the
//      promo_code (omitted from body when NULL in mapping).
//   7. Return success with the returned userMembershipId (may be null per DQ7
//      if Glofox returns 2xx but doesn't echo the id — still success).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  HandlerResult,
  PushPressWebhookBody,
} from "../../_shared/types.ts";
import { GlofoxApiError } from "../../_shared/glofox-client.ts";
import type { PushPressClient } from "../../_shared/pushpress-client.ts";
import { isSaunaPlanCategory } from "../../_shared/filter.ts";
import { getOrCreateMemberLink, getPlanMapping } from "../../_shared/mappings.ts";

export interface EnrollmentCreatedDeps {
  supabase: SupabaseClient;
  glofox: GlofoxClientShape;
  pushpress: PushPressClient;
}

export async function handleEnrollmentCreated(
  body: PushPressWebhookBody,
  deps: EnrollmentCreatedDeps,
): Promise<HandlerResult> {
  const data = body.data as {
    id?: string;
    customerId?: string;
    planId?: string;
    startDate?: string | null;
  };

  // --- 1. Guards ----------------------------------------------------------
  if (!data.id || !data.customerId) {
    return {
      status: "failed",
      error: "enrollment payload missing required fields (id, customerId)",
    };
  }
  if (!data.planId) {
    return { status: "failed", error: "missing_planId" };
  }

  // --- 2. Resolve the PushPress plan for category.name -------------------
  let ppPlan: { category: { name: string } };
  try {
    ppPlan = await deps.pushpress.getPlan(data.planId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", error: `pushpress.getPlan failed: ${message}` };
  }

  // --- 3. Q9 plan-category filter ----------------------------------------
  if (!isSaunaPlanCategory(ppPlan.category.name)) {
    return {
      status: "filtered",
      error: `plan_category_not_in_allowlist:${ppPlan.category.name || "<empty>"}`,
    };
  }

  // --- 4. Look up the plan_mappings row ----------------------------------
  let planMapping: Awaited<ReturnType<typeof getPlanMapping>>;
  try {
    planMapping = await getPlanMapping(deps.supabase, data.planId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", error: `plan_mapping lookup failed: ${message}` };
  }

  if (!planMapping) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "unmapped_plan",
        plan_id: data.planId,
        customer_id: data.customerId,
      }),
    );
    return { status: "failed", error: `unmapped_plan:${data.planId}` };
  }

  // --- 5. Resolve PushPress customer → Glofox user -----------------------
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
    return { status: "failed", error: `member_unlinkable: ${message}` };
  }

  // --- 6. Purchase the membership on Glofox ------------------------------
  const startDate = typeof data.startDate === "string" && data.startDate.length >= 10
    ? data.startDate.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  try {
    const purchase = await deps.glofox.purchaseMembership({
      userId: memberLink.glofoxUserId,
      membershipId: planMapping.glofoxMembershipId,
      planCode: planMapping.glofoxPlanCode,
      paymentMethod: planMapping.paymentMethod,
      promoCode: planMapping.glofoxPromoCode ?? undefined,
      startDate,
    });

    // userMembershipId may be null per DQ7 — still success. PR 3 will need
    // it for cancel handling; if null, the cancel handler will have to look
    // it up by other means (e.g. re-query Glofox by user + membership).
    return {
      status: "success",
      glofoxResponse: { userMembershipId: purchase.userMembershipId },
    };
  } catch (err) {
    if (err instanceof GlofoxApiError) {
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
