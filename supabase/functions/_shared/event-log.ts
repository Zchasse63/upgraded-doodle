// event_log helpers.
//
// Two operations:
//   insertEventLog(...) — inserts a 'pending' (or 'failed' for signature
//     failures) row. On dedup_key unique violation, returns {duplicate: true}
//     without throwing; this is the idempotency gate.
//
//   updateEventLog(...) — called after the handler runs to record the final
//     status, duration, and any Glofox response detail.
//
// If the Edge Function dies between INSERT and UPDATE, the row remains
// 'pending' — visible to ops as a stuck handler.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { HandlerStatus } from "./types.ts";

export interface InsertEventLogArgs {
  dedupKey: string;
  event: string;
  companyId?: string;
  signatureVerified: boolean;
  handlerStatus: HandlerStatus;
  handlerError?: string;
  durationMs?: number;
  payload: unknown;
  glofoxResponse?: unknown;
}

export async function insertEventLog(
  supabase: SupabaseClient,
  args: InsertEventLogArgs,
): Promise<{ duplicate: boolean }> {
  const { error } = await supabase.from("event_log").insert({
    dedup_key: args.dedupKey,
    pushpress_event: args.event,
    pushpress_company_id: args.companyId ?? null,
    signature_verified: args.signatureVerified,
    handler_status: args.handlerStatus,
    handler_error: args.handlerError ?? null,
    duration_ms: args.durationMs ?? null,
    payload: args.payload,
    glofox_response: args.glofoxResponse ?? null,
  });

  if (error) {
    // Postgres unique-violation on dedup_key — this is the dedup signal.
    if (error.code === "23505") return { duplicate: true };
    throw new EventLogError(`insertEventLog failed: ${error.message}`, error);
  }

  return { duplicate: false };
}

export interface UpdateEventLogArgs {
  handlerStatus: HandlerStatus;
  handlerError?: string;
  durationMs: number;
  glofoxResponse?: unknown;
}

export async function updateEventLog(
  supabase: SupabaseClient,
  dedupKey: string,
  update: UpdateEventLogArgs,
): Promise<void> {
  const { error } = await supabase
    .from("event_log")
    .update({
      handler_status: update.handlerStatus,
      handler_error: update.handlerError ?? null,
      duration_ms: update.durationMs,
      glofox_response: update.glofoxResponse ?? null,
    })
    .eq("dedup_key", dedupKey);

  if (error) {
    throw new EventLogError(`updateEventLog failed: ${error.message}`, error);
  }
}

export class EventLogError extends Error {
  constructor(message: string, public override readonly cause: unknown) {
    super(message);
    this.name = "EventLogError";
  }
}
