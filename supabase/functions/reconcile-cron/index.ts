// reconcile-cron Edge Function — scheduled safety-net.
//
// Runs the audit half of scripts/reconcile.ts (no replay, never mutates).
// Posts a summary to Slack if SLACK_OPS_WEBHOOK_URL is set. Returns JSON
// with the gap counts.
//
// Auth: Bearer CRON_SECRET. If CRON_SECRET is empty, no auth required (dev
// mode). Set the secret in production via `supabase secrets set CRON_SECRET=...`.
//
// Triggered by Supabase's cron scheduler (config in supabase/config.toml).
// Can also be invoked manually:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.supabase.co/functions/v1/reconcile-cron
//
// This file deliberately reimplements (not imports) the audit logic from
// scripts/reconcile.ts. The scripts/ version uses Deno.exit and a CLI-arg
// parser that don't make sense inside an Edge Function. Both versions share
// the same query patterns, so a change in one should be mirrored in the other.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const PP_KEY = Deno.env.get("PUSHPRESS_API_KEY") ?? "";
const PP_CO = Deno.env.get("PUSHPRESS_COMPANY_ID") ?? "";
const PP_BASE_URL = (() => {
  const server = Deno.env.get("PUSHPRESS_SERVER") ?? "production";
  if (server === "staging") return "https://api.pushpressstage.com/v3";
  if (server === "development") return "https://api.pushpressdev.com/v3";
  return "https://api.pushpress.com/v3";
})();
const SLACK_URL = Deno.env.get("SLACK_OPS_WEBHOOK_URL") ?? "";
const LOOKAHEAD_DAYS = parseInt(Deno.env.get("RECONCILE_LOOKAHEAD_DAYS") ?? "30", 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function parseAllowlist(raw: string | undefined): readonly string[] {
  return Object.freeze(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

const SAUNA_CLASS_TYPES = parseAllowlist(Deno.env.get("SAUNA_CLASS_TYPE_ALLOWLIST"));
const SAUNA_PLAN_CATEGORIES = parseAllowlist(Deno.env.get("SAUNA_PLAN_CATEGORY_ALLOWLIST"));

interface PPClass {
  id: string;
  classTypeName?: string | null;
  start: number;
  title?: string | null;
}
interface PPReservation {
  id: string;
  reservedId: string;
  customerId?: string | null;
  status: string;
}
interface PPEnrollment {
  id: string;
  customerId: string;
  planId?: string | null;
  status: string;
}
interface PPPlan {
  id: string;
  category?: { name?: string };
}

const PP_REQUEST_TIMEOUT_MS = 10_000;

async function ppGet<T>(path: string): Promise<T> {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), PP_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${PP_BASE_URL}${path}`, {
      headers: { "API-KEY": PP_KEY, "company-id": PP_CO, "Accept": "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PushPress ${res.status} ${path}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(await res.text()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`PushPress timeout after ${PP_REQUEST_TIMEOUT_MS}ms on ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function listSaunaClassesAhead(days: number): Promise<PPClass[]> {
  const startsAfter = Math.floor(Date.now() / 1000);
  const startsBefore = startsAfter + days * 86400;
  const out: PPClass[] = [];
  let page = 1;
  let pastWindow = false;
  while (page < 50 && !pastWindow) {
    const res = await ppGet<{ data: { resultArray: PPClass[] } }>(
      `/classes?limit=100&page=${page}&startsAfter=${startsAfter}`,
    );
    const batch = res.data.resultArray ?? [];
    for (const c of batch) {
      if (c.start > startsBefore) {
        // PushPress returns classes in ascending start order. Once we cross
        // the window boundary, every remaining item (this page and beyond)
        // is also out of window — stop paginating.
        pastWindow = true;
        break;
      }
      if (!c.classTypeName) continue;
      if (!SAUNA_CLASS_TYPES.includes(c.classTypeName.trim().toLowerCase())) continue;
      out.push(c);
    }
    if (batch.length < 100) break;
    page++;
  }
  return out;
}

async function listReservationsForClass(classId: string): Promise<PPReservation[]> {
  const out: PPReservation[] = [];
  let page = 1;
  while (page < 20) {
    const res = await ppGet<{ data: { resultArray: PPReservation[] } }>(
      `/reservations?calendarItemId=${encodeURIComponent(classId)}&limit=100&page=${page}`,
    );
    const batch = res.data.resultArray ?? [];
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return out;
}

async function countReservationGaps(): Promise<number> {
  const classes = await listSaunaClassesAhead(LOOKAHEAD_DAYS);
  let gaps = 0;
  for (const cls of classes) {
    const reservations = await listReservationsForClass(cls.id);
    const active = reservations.filter((r) => r.status === "reserved");
    for (const res of active) {
      // Type guard: a non-string id from a hypothetical PushPress API change
      // would silently make the .filter() match nothing and inflate the gap
      // count. Skip with a structured log instead so we notice.
      if (typeof res.id !== "string") {
        console.error(JSON.stringify({
          level: "warn",
          msg: "reservation_id_not_string_skipping",
          class_id: cls.id,
          actual_type: typeof res.id,
        }));
        continue;
      }
      const { data } = await supabase
        .from("event_log")
        .select("dedup_key")
        .eq("pushpress_event", "reservation.created")
        .filter("payload->data->>id", "eq", res.id)
        .eq("handler_status", "success")
        .limit(1)
        .maybeSingle();
      if (!data) gaps++;
    }
  }
  return gaps;
}

const planCategoryCache = new Map<string, string>();
async function getPlanCategory(planId: string): Promise<string> {
  const cached = planCategoryCache.get(planId);
  if (cached !== undefined) return cached;
  try {
    const plan = await ppGet<PPPlan>(`/plans/${encodeURIComponent(planId)}`);
    const cat = (plan.category?.name ?? "").trim().toLowerCase();
    planCategoryCache.set(planId, cat);
    return cat;
  } catch {
    planCategoryCache.set(planId, "");
    return "";
  }
}

async function countEnrollmentGaps(): Promise<number> {
  const out: PPEnrollment[] = [];
  let page = 1;
  while (page < 50) {
    const res = await ppGet<{ data: { resultArray: PPEnrollment[] } }>(
      `/enrollments?status=active&limit=100&page=${page}`,
    );
    const batch = res.data.resultArray ?? [];
    for (const e of batch) {
      if (!e.planId) continue;
      const cat = await getPlanCategory(e.planId);
      if (!SAUNA_PLAN_CATEGORIES.includes(cat)) continue;
      out.push(e);
    }
    if (batch.length < 100) break;
    page++;
  }

  let gaps = 0;
  for (const e of out) {
    if (typeof e.id !== "string") {
      console.error(JSON.stringify({
        level: "warn",
        msg: "enrollment_id_not_string_skipping",
        plan_id: e.planId,
        actual_type: typeof e.id,
      }));
      continue;
    }
    const { data } = await supabase
      .from("event_log")
      .select("dedup_key")
      .eq("pushpress_event", "enrollment.created")
      .filter("payload->data->>id", "eq", e.id)
      .eq("handler_status", "success")
      .limit(1)
      .maybeSingle();
    if (!data) gaps++;
  }
  return gaps;
}

async function postSlack(reservationGaps: number, enrollmentGaps: number): Promise<void> {
  if (!SLACK_URL) return;
  const total = reservationGaps + enrollmentGaps;
  if (total === 0) {
    // Optional: post a green check daily? Keep noise low — skip on zero.
    return;
  }
  const text = `[tsg-cc-bridge] reconcile: ${reservationGaps} reservation gap(s), ${enrollmentGaps} enrollment gap(s)`;
  try {
    await fetch(SLACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: "warn",
      msg: "slack_post_failed_in_reconcile_cron",
      err: err instanceof Error ? err.message : String(err),
    }));
  }
}

// Constant-time string compare via HMAC-SHA256 commitment. Both inputs are
// hashed with a fresh per-request key, then the resulting fixed-length digests
// are compared byte-for-byte. This neutralizes length-based timing oracles
// even if CRON_SECRET length changes between deployments.
const COMPARE_ENC = new TextEncoder();
async function safeBearerEquals(provided: string, expected: string): Promise<boolean> {
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [a, b] = await Promise.all([
    crypto.subtle.sign("HMAC", key, COMPARE_ENC.encode(provided)),
    crypto.subtle.sign("HMAC", key, COMPARE_ENC.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  if (av.length !== bv.length) return false;
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  // Auth is always required. An empty CRON_SECRET is a misconfiguration,
  // not "dev mode" — without auth this function exposes reconcile output
  // and inadvertently surfaces internal state (gap counts) to any caller.
  if (!CRON_SECRET) {
    console.error(JSON.stringify({
      level: "error",
      msg: "reconcile_cron_unconfigured_CRON_SECRET",
    }));
    return new Response(
      JSON.stringify({ error: "CRON_SECRET not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (!(await safeBearerEquals(auth, `Bearer ${CRON_SECRET}`))) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!PP_KEY || !PP_CO || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ error: "missing required env vars" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const startedAt = Date.now();
  let reservationGaps = 0;
  let enrollmentGaps = 0;
  const errors: string[] = [];

  try {
    reservationGaps = await countReservationGaps();
  } catch (err) {
    errors.push(`reservations: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    enrollmentGaps = await countEnrollmentGaps();
  } catch (err) {
    errors.push(`enrollments: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.error(JSON.stringify({
    level: "info",
    msg: "reconcile_cron_complete",
    reservation_gaps: reservationGaps,
    enrollment_gaps: enrollmentGaps,
    duration_ms: Date.now() - startedAt,
    errors,  // full details only in structured logs
  }));

  await postSlack(reservationGaps, enrollmentGaps);

  // Response body intentionally excludes raw error strings. Detailed errors
  // (with upstream URLs, response bodies, etc.) are written to the Edge
  // Function log only — anyone holding the CRON_SECRET should not get a
  // diagnostics window into upstream API state via this endpoint.
  return new Response(
    JSON.stringify({
      reservationGaps,
      enrollmentGaps,
      durationMs: Date.now() - startedAt,
      hadErrors: errors.length > 0,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
