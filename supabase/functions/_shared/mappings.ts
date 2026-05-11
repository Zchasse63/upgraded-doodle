// DB-backed resolution helpers. No business logic — handlers orchestrate.
//
// getOrCreateMemberLink   PushPress customer_id → Glofox user_id
//                         (auto-creates a Glofox lead on miss)
//
// getOrResolveSlotMapping PushPress calendar_item_id → Glofox event_id
//                         (lazy cache; resolves by time window on miss)
//
// enqueuePendingRefund    queue a refund-needed record for ops
//                         (idempotent on pushpress_reservation_id)

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  MemberLink,
  PlanMapping,
  SlotMapping,
} from "./types.ts";
import type { PushPressClient } from "./pushpress-client.ts";

const GLOFOX_EVENT_WINDOW_SECONDS = 60;

// --- Member link ------------------------------------------------------------

export async function getOrCreateMemberLink(
  supabase: SupabaseClient,
  glofox: GlofoxClientShape,
  pushpress: PushPressClient,
  pushpressCustomerId: string,
): Promise<MemberLink> {
  // 1. Cache hit?
  const existing = await selectMemberLink(supabase, pushpressCustomerId);
  if (existing) return existing;

  // 2. Cache miss — fetch the PushPress customer to get email + name.
  const customer = await pushpress.getCustomer(pushpressCustomerId);
  if (!customer.email) {
    throw new Error(`PushPress customer ${pushpressCustomerId} has no email`);
  }

  // 3. Try matching the email against an existing Glofox member.
  const glofoxMember = await glofox.retrieveMemberByEmail(customer.email);
  if (glofoxMember) {
    return await insertMemberLink(
      supabase,
      pushpressCustomerId,
      glofoxMember._id,
      customer.email,
      "email_match",
    );
  }

  // 4. No Glofox member — auto-create a lead.
  const lead = await glofox.createLead({
    email: customer.email,
    firstName: customer.name.first,
    lastName: customer.name.last,
    phone: customer.phone,
  });
  return await insertMemberLink(
    supabase,
    pushpressCustomerId,
    lead._id,
    customer.email,
    "auto_create_lead",
  );
}

async function insertMemberLink(
  supabase: SupabaseClient,
  pushpressCustomerId: string,
  glofoxUserId: string,
  email: string,
  linkedVia: "email_match" | "manual" | "auto_create_lead",
): Promise<MemberLink> {
  const { error } = await supabase.from("members_link").insert({
    pushpress_customer_id: pushpressCustomerId,
    glofox_user_id: glofoxUserId,
    email,
    linked_via: linkedVia,
  });

  if (!error) return { pushpressCustomerId, glofoxUserId, email };

  // 23505: another concurrent request linked this customer first. Re-read
  // and return whatever ended up in the table — that's the authoritative
  // mapping going forward.
  if (error.code === "23505") {
    const existing = await selectMemberLink(supabase, pushpressCustomerId);
    if (existing) return existing;
    // Shouldn't happen — the unique violation says a row exists, but the
    // SELECT couldn't find it. Treat as a hard error instead of silently
    // returning unverified values that would corrupt the cache.
    throw new Error(
      `members_link 23505 on ${pushpressCustomerId} but row not found on re-read`,
    );
  }

  throw new Error(`members_link insert failed: ${error.message}`);
}

// --- Slot mapping -----------------------------------------------------------

export async function getOrResolveSlotMapping(
  supabase: SupabaseClient,
  glofox: GlofoxClientShape,
  pushpressCalendarItemId: string,
  classStart: number,
  expectedClassTypeName: string | null,
): Promise<SlotMapping | null> {
  // 1. Cache hit?
  const { data: existing, error: selectError } = await supabase
    .from("slot_mappings")
    .select("pushpress_calendar_item_id, glofox_event_id, class_type")
    .eq("pushpress_calendar_item_id", pushpressCalendarItemId)
    .maybeSingle();

  if (selectError) {
    throw new Error(`slot_mappings select failed: ${selectError.message}`);
  }
  if (existing) {
    return {
      pushpressCalendarItemId: existing.pushpress_calendar_item_id,
      glofoxEventId: existing.glofox_event_id,
      classType: existing.class_type,
    };
  }

  // 2. Miss — query Glofox for events in a small window around the start.
  const windowFrom = classStart - GLOFOX_EVENT_WINDOW_SECONDS;
  const windowTo = classStart + GLOFOX_EVENT_WINDOW_SECONDS;
  const events = await glofox.getEventsByTimeRange(windowFrom, windowTo);

  // 3. Filter by (a) class type name and (b) time_start within our window.
  // Glofox events are named more specifically (e.g. "Open Sauna", "Guided
  // Sauna + Cold Plunge") than PushPress class types (just "Sauna"), so
  // we substring-match. The time_start check is defense in depth: Glofox
  // has been observed to return events OUTSIDE the requested window when
  // filter params are wrong or unsupported — without this check, we'd cache
  // a wrong mapping and mirror future bookings to the wrong Glofox event.
  const expected = expectedClassTypeName?.trim().toLowerCase();
  const match = events.find((e) => {
    if (e.time_start < windowFrom || e.time_start > windowTo) return false;
    if (!expected) return true;
    return (e.name ?? "").toLowerCase().includes(expected);
  });

  if (!match) return null;

  // 4. Cache.
  const { error: insertError } = await supabase.from("slot_mappings").insert({
    pushpress_calendar_item_id: pushpressCalendarItemId,
    glofox_event_id: match._id,
    start_ts: match.time_start,
    end_ts: match.time_start, // we don't have end from this endpoint; fine for v1
    class_type: expectedClassTypeName ?? match.name ?? null,
  });

  // Concurrent insert is fine — both rows would have the same Glofox event id.
  if (insertError && insertError.code !== "23505") {
    throw new Error(`slot_mappings insert failed: ${insertError.message}`);
  }

  return {
    pushpressCalendarItemId,
    glofoxEventId: match._id,
    classType: expectedClassTypeName ?? match.name ?? null,
  };
}

// --- Pending refunds --------------------------------------------------------

// --- Plan mappings ---------------------------------------------------------

export async function getPlanMapping(
  supabase: SupabaseClient,
  pushpressPlanId: string,
): Promise<PlanMapping | null> {
  const { data, error } = await supabase
    .from("plan_mappings")
    .select(
      "pushpress_plan_id, pushpress_plan_name, glofox_membership_id, glofox_plan_code, payment_method, glofox_promo_code, is_active",
    )
    .eq("pushpress_plan_id", pushpressPlanId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw new Error(`plan_mappings select failed: ${error.message}`);
  if (!data) return null;

  return {
    pushpressPlanId: data.pushpress_plan_id,
    pushpressPlanName: data.pushpress_plan_name,
    glofoxMembershipId: data.glofox_membership_id,
    glofoxPlanCode: data.glofox_plan_code,
    paymentMethod: data.payment_method,
    glofoxPromoCode: data.glofox_promo_code,
    isActive: data.is_active,
  };
}

// --- Enrollment links ------------------------------------------------------

export interface EnrollmentLink {
  pushpressEnrollmentId: string;
  pushpressCustomerId: string;
  glofoxUserMembershipId: string | null;
  linkedVia: "enrollment_created" | "glofox_query" | "manual";
}

export async function getEnrollmentLink(
  supabase: SupabaseClient,
  pushpressEnrollmentId: string,
): Promise<EnrollmentLink | null> {
  const { data, error } = await supabase
    .from("pushpress_enrollment_links")
    .select(
      "pushpress_enrollment_id, pushpress_customer_id, glofox_user_membership_id, linked_via",
    )
    .eq("pushpress_enrollment_id", pushpressEnrollmentId)
    .maybeSingle();

  if (error) {
    throw new Error(`pushpress_enrollment_links select failed: ${error.message}`);
  }
  if (!data) return null;

  return {
    pushpressEnrollmentId: data.pushpress_enrollment_id,
    pushpressCustomerId: data.pushpress_customer_id,
    glofoxUserMembershipId: data.glofox_user_membership_id,
    linkedVia: data.linked_via,
  };
}

export async function insertEnrollmentLink(
  supabase: SupabaseClient,
  args: {
    pushpressEnrollmentId: string;
    pushpressCustomerId: string;
    glofoxUserMembershipId: string | null;
    linkedVia: EnrollmentLink["linkedVia"];
  },
): Promise<void> {
  const { error } = await supabase.from("pushpress_enrollment_links").insert({
    pushpress_enrollment_id: args.pushpressEnrollmentId,
    pushpress_customer_id: args.pushpressCustomerId,
    glofox_user_membership_id: args.glofoxUserMembershipId,
    linked_via: args.linkedVia,
  });
  if (error && error.code !== "23505") {
    throw new Error(`pushpress_enrollment_links insert failed: ${error.message}`);
  }
}

export async function updateEnrollmentLinkUserMembershipId(
  supabase: SupabaseClient,
  pushpressEnrollmentId: string,
  glofoxUserMembershipId: string,
): Promise<void> {
  const { error } = await supabase
    .from("pushpress_enrollment_links")
    .update({
      glofox_user_membership_id: glofoxUserMembershipId,
      linked_via: "glofox_query",
    })
    .eq("pushpress_enrollment_id", pushpressEnrollmentId);
  if (error) {
    throw new Error(`pushpress_enrollment_links update failed: ${error.message}`);
  }
}

// Read-only member_link select — used by handlers that should NOT auto-create
// a lead (checkin.created, customer.details.changed). Mirrors selectMemberLink
// internally but exported for handler use.
export async function selectMemberLink(
  supabase: SupabaseClient,
  pushpressCustomerId: string,
): Promise<MemberLink | null> {
  const { data, error } = await supabase
    .from("members_link")
    .select("pushpress_customer_id, glofox_user_id, email")
    .eq("pushpress_customer_id", pushpressCustomerId)
    .maybeSingle();
  if (error) throw new Error(`members_link select failed: ${error.message}`);
  if (!data) return null;
  return {
    pushpressCustomerId: data.pushpress_customer_id,
    glofoxUserId: data.glofox_user_id,
    email: data.email,
  };
}

// Read-only slot_mappings select — used by handlers that should NOT lazily
// resolve a new slot (checkin.created). If a checkin arrives without a prior
// reservation.created mapping, that's an ops issue, not something to paper over.
export async function selectSlotMapping(
  supabase: SupabaseClient,
  pushpressCalendarItemId: string,
): Promise<SlotMapping | null> {
  const { data, error } = await supabase
    .from("slot_mappings")
    .select("pushpress_calendar_item_id, glofox_event_id, class_type")
    .eq("pushpress_calendar_item_id", pushpressCalendarItemId)
    .maybeSingle();
  if (error) throw new Error(`slot_mappings select failed: ${error.message}`);
  if (!data) return null;
  return {
    pushpressCalendarItemId: data.pushpress_calendar_item_id,
    glofoxEventId: data.glofox_event_id,
    classType: data.class_type,
  };
}

// DQ7 fallback: when pushpress_enrollment_links has no userMembershipId for
// this enrollment, query Glofox for the user's memberships and find the
// active NOEQL one. Caches the discovered ID back to enrollment_links.
//
// Returns null if no unique active membership matches (don't guess).
export async function lookupMemberMembership(
  glofox: GlofoxClientShape,
  supabase: SupabaseClient,
  glofoxUserId: string,
  pushpressEnrollmentId: string,
  expectedMembershipId: string,
): Promise<string | null> {
  const memberships = await glofox.getMemberMemberships(glofoxUserId);
  // Filter to active memberships matching the expected plan-level membership_id.
  const candidates = memberships.filter((m) =>
    m.membership_id === expectedMembershipId &&
    m.status.toUpperCase() !== "CANCELED"
  );
  if (candidates.length !== 1) {
    console.error(JSON.stringify({
      level: "warn",
      msg: "lookupMemberMembership ambiguous",
      glofox_user_id: glofoxUserId,
      expected_membership_id: expectedMembershipId,
      candidate_count: candidates.length,
    }));
    return null;
  }
  const id = candidates[0]._id;
  try {
    await updateEnrollmentLinkUserMembershipId(supabase, pushpressEnrollmentId, id);
  } catch (err) {
    // Cache write is best-effort — log but don't fail the lookup.
    console.error(JSON.stringify({
      level: "warn",
      msg: "lookupMemberMembership cache write failed",
      err: err instanceof Error ? err.message : String(err),
    }));
  }
  return id;
}

// --- Pending refunds --------------------------------------------------------

export async function enqueuePendingRefund(
  supabase: SupabaseClient,
  args: {
    reservationId: string;
    customerId: string;
    calendarItemId: string;
    reason:
      | "capacity_full"
      | "slot_unmappable"
      | "member_unlinkable"
      | "glofox_5xx"
      | "class_cancel_glofox_failed"
      | "other";
    glofoxError?: string;
  },
): Promise<void> {
  const { error } = await supabase.from("pending_refunds").insert({
    pushpress_reservation_id: args.reservationId,
    pushpress_customer_id: args.customerId,
    pushpress_calendar_item_id: args.calendarItemId,
    failure_reason: args.reason,
    glofox_error: args.glofoxError ?? null,
  });

  // 23505 = already queued; idempotent no-op.
  if (error && error.code !== "23505") {
    throw new Error(`pending_refunds insert failed: ${error.message}`);
  }
}
