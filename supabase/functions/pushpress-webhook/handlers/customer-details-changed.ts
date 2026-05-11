// Handler for the PushPress `customer.details.changed` webhook.
//
// PushPress sends a full Customer snapshot when a member edits their profile.
// We mirror only the four fields Glofox actually cares about: first_name,
// last_name, email, phone.
//
// Read-only member-link lookup: if the customer isn't yet linked to a Glofox
// user (no prior reservation or enrollment), skip silently. A profile-change
// event is NOT a good trigger for auto-creating a Glofox lead — that would
// produce orphan leads for every CC member who edits their profile, including
// CrossFit-only members who never use sauna.
//
// No debouncing in v1: PushPress can fire this multiple times per second
// during profile edits. Overhead is acceptable at current volume; debouncing
// is a v2 concern (architecture.md § 3h).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type {
  GlofoxClientShape,
  HandlerResult,
  PushPressWebhookBody,
} from "../../_shared/types.ts";
import { GlofoxApiError } from "../../_shared/glofox-client.ts";
import { selectMemberLink } from "../../_shared/mappings.ts";
import { alertOps } from "../../_shared/slack.ts";

export interface CustomerDetailsChangedDeps {
  supabase: SupabaseClient;
  glofox: GlofoxClientShape;
}

export async function handleCustomerDetailsChanged(
  body: PushPressWebhookBody,
  deps: CustomerDetailsChangedDeps,
): Promise<HandlerResult> {
  const data = body.data as {
    id?: string;
    name?: { first?: string; last?: string };
    email?: string;
    phone?: string | null;
  };

  if (!data.id) {
    return { status: "failed", error: "customer payload missing id" };
  }

  const memberLink = await selectMemberLink(deps.supabase, data.id);
  if (!memberLink) {
    return { status: "skipped", error: "member_not_linked" };
  }

  const firstName = data.name?.first ?? "";
  const lastName = data.name?.last ?? "";
  const email = typeof data.email === "string" ? data.email : "";
  const phone = typeof data.phone === "string" ? data.phone : null;

  if (!email) {
    // Glofox requires an email on member update; without it the PUT would
    // fail anyway. Skip and let ops investigate the source payload.
    return { status: "failed", error: "customer payload missing email" };
  }

  try {
    await deps.glofox.updateMember({
      userId: memberLink.glofoxUserId,
      firstName,
      lastName,
      email,
      phone,
    });
    return { status: "success" };
  } catch (err) {
    if (err instanceof GlofoxApiError) {
      if (err.status >= 500) {
        await alertOps(deps.supabase, "customer.details.changed", {
          reason: "glofox_5xx",
          user_id: memberLink.glofoxUserId,
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
