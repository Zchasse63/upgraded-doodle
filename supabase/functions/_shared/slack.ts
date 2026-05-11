// Slack ops alerts. Lazy-reads SLACK_OPS_WEBHOOK_URL; no-op if empty.
//
// Throttling: counts the same alert type in event_log over the last 60s and
// suppresses if there's already been >= 5 of them. Prevents 100-booking
// fan-out from generating 100 Slack messages. The count check is best-effort —
// slight over-alerting (race condition between SELECT and POST) is acceptable.
//
// Failure isolation: a Slack POST failure never propagates to the caller.
// The bridge's handler logic must succeed regardless of alerting health.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const THROTTLE_WINDOW_SECONDS = 60;
const THROTTLE_MAX_PER_WINDOW = 5;
const MAX_DETAIL_CHARS = 500;

export async function alertOps(
  supabase: SupabaseClient,
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const url = Deno.env.get("SLACK_OPS_WEBHOOK_URL") ?? "";
  if (!url) {
    console.error(JSON.stringify({
      level: "info",
      msg: "slack_not_configured",
      event,
    }));
    return;
  }

  // Throttle by counting recent failed rows for the same event. Failures only
  // — we don't want successful events to drown out real alerts.
  const cutoff = new Date(Date.now() - THROTTLE_WINDOW_SECONDS * 1000).toISOString();
  const { count } = await supabase
    .from("event_log")
    .select("dedup_key", { count: "exact", head: true })
    .eq("pushpress_event", event)
    .eq("handler_status", "failed")
    .gte("received_at", cutoff);
  if ((count ?? 0) >= THROTTLE_MAX_PER_WINDOW) {
    console.error(JSON.stringify({
      level: "info",
      msg: "slack_alert_throttled",
      event,
      window_seconds: THROTTLE_WINDOW_SECONDS,
      count_in_window: count,
    }));
    return;
  }

  const detailJson = JSON.stringify(detail);
  const text = `[tsg-cc-bridge] ${event}: ${
    detailJson.length > MAX_DETAIL_CHARS
      ? `${detailJson.slice(0, MAX_DETAIL_CHARS)}…[truncated]`
      : detailJson
  }`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(JSON.stringify({
        level: "warn",
        msg: "slack_post_failed",
        status: res.status,
        event,
      }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      level: "warn",
      msg: "slack_post_threw",
      err: err instanceof Error ? err.message : String(err),
      event,
    }));
  }
}
