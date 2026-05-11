// Reconciliation script — compares PushPress's source of truth against our
// event_log + Glofox state. Detects missed webhooks (provider outage, our
// function down, network blip, subscription paused, subscription wasn't yet
// active at the time of the action).
//
// Two audit modes:
//   reservations — sauna class reservations (PR 1 reservation.created path)
//   enrollments  — sauna plan enrollments (PR 2 enrollment.created path)
//
// Usage:
//   deno run --allow-net --allow-env --env-file=.env.local \
//     scripts/reconcile.ts \
//     [--mode reservations|enrollments|all] [--days N] [--replay]
//
// Flags:
//   --mode TYPE   What to audit (default: all)
//   --days N      Look at sauna classes starting in the next N days
//                 (default 30; only applies to reservations mode)
//   --replay      For each detected gap, synthesize the webhook payload, sign
//                 it with PUSHPRESS_WEBHOOK_SIGNING_SECRET, and POST it to
//                 the deployed function. The function's own dedup handles
//                 re-runs safely. WITHOUT this flag the script is audit-only.
//
// Operational use cases:
//   - Pre-cutover: enumerate any pre-existing reservations/enrollments
//   - Periodic safety net (cron): hourly run catches delivery gaps
//   - Post-incident: replay events that were missed during an outage
//   - Bootstrap PR 2: replay the 3 enrollment.created events that were
//     skipped under the PR 1 stub handler

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// --- Config -----------------------------------------------------------------

const PP_KEY = mustEnv("PUSHPRESS_API_KEY");
const PP_CO = mustEnv("PUSHPRESS_COMPANY_ID");
const PP_BASE = "https://api.pushpress.com/v3";

const SAUNA_CLASS_TYPES = parseAllowlist(Deno.env.get("SAUNA_CLASS_TYPE_ALLOWLIST"));
const SAUNA_PLAN_CATEGORIES = parseAllowlist(Deno.env.get("SAUNA_PLAN_CATEGORY_ALLOWLIST"));

const FUNCTION_URL = Deno.env.get("PUSHPRESS_WEBHOOK_URL") ??
  "https://pygbvcqjpwfodmoqkhos.supabase.co/functions/v1/pushpress-webhook";
const SIGNING_SECRET = Deno.env.get("PUSHPRESS_WEBHOOK_SIGNING_SECRET") ?? "";

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const ENC = new TextEncoder();

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`error: ${name} is not set`);
    Deno.exit(1);
  }
  return v;
}

function parseAllowlist(raw: string | undefined): readonly string[] {
  return Object.freeze(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

// --- CLI args ---------------------------------------------------------------

const args = Deno.args;
const daysArgIdx = args.indexOf("--days");
const lookAheadDays = daysArgIdx >= 0 ? Number(args[daysArgIdx + 1]) : 30;
const replay = args.includes("--replay");

const modeArgIdx = args.indexOf("--mode");
const mode = (modeArgIdx >= 0 ? args[modeArgIdx + 1] : "all") as
  | "reservations"
  | "enrollments"
  | "all";
if (!["reservations", "enrollments", "all"].includes(mode)) {
  console.error(`error: --mode must be reservations | enrollments | all`);
  Deno.exit(1);
}

// --only IDS — filters gaps to a specific enrollment_id or reservation_id
// (or comma-separated list). Useful for single-user dry runs before flipping
// GLOFOX_MODE=live across the entire gap list.
const onlyArgIdx = args.indexOf("--only");
const onlyFilter: ReadonlySet<string> = onlyArgIdx >= 0
  ? new Set(
    args[onlyArgIdx + 1].split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  )
  : new Set();
const isOnlyFiltered = onlyFilter.size > 0;

if (replay && !SIGNING_SECRET) {
  console.error("error: --replay requires PUSHPRESS_WEBHOOK_SIGNING_SECRET");
  Deno.exit(1);
}

// --- PushPress helpers ------------------------------------------------------

interface PPClass {
  id: string;
  classTypeName?: string | null;
  start: number;
  end: number;
  title?: string | null;
}

interface PPReservation {
  id: string;
  reservedId: string;
  customerId?: string | null;
  companyId?: string | null;
  registrationTimestamp: number;
  status: string;
}

interface PPEnrollment {
  id: string;
  customerId: string;
  companyId: string;
  planId?: string | null;
  status: string;
  startDate?: string | null;
  billingSchedule?: { period?: string; interval?: number };
}

interface PPPlan {
  id: string;
  name: string;
  category?: { name?: string };
}

async function ppGet<T>(path: string): Promise<T> {
  const res = await fetch(`${PP_BASE}${path}`, {
    headers: { "API-KEY": PP_KEY, "company-id": PP_CO, "Accept": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PushPress ${res.status} ${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

// --- HMAC sign --------------------------------------------------------------

async function signData(data: unknown): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENC.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, ENC.encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function postSyntheticWebhook(body: unknown): Promise<{ status: number; text: string }> {
  // deno-lint-ignore no-explicit-any
  const sig = await signData((body as any).data);
  const rawBody = JSON.stringify(body);
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(rawBody.length),
      "webhook-signature": sig,
    },
    body: rawBody,
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 160) };
}

// --- Reservations audit -----------------------------------------------------

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
        // PushPress returns classes in ascending start order — first out-of-
        // window item means the rest of this page and all subsequent pages
        // are also out of window. Stop paginating instead of skipping.
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

interface ReservationGap {
  reservation: PPReservation;
  className: string;
  classStart: number;
}

async function auditReservations(): Promise<ReservationGap[]> {
  console.log(`\n[reservations] window: next ${lookAheadDays} days`);
  console.log(`[reservations] class-type allowlist: ${SAUNA_CLASS_TYPES.join(", ") || "<empty>"}`);

  const saunaClasses = await listSaunaClassesAhead(lookAheadDays);
  console.log(`[reservations] sauna classes in window: ${saunaClasses.length}`);

  const gaps: ReservationGap[] = [];
  let activeChecked = 0;

  for (const cls of saunaClasses) {
    const reservations = await listReservationsForClass(cls.id);
    const active = reservations.filter((r) => r.status === "reserved");
    activeChecked += active.length;

    for (const res of active) {
      // Gap = no `success` event_log row. Rows in handler_status=failed/
      // filtered/skipped don't count as mirrored — they're either dropped
      // or actively need replay. Mirrors auditEnrollments() semantics.
      const { data, error } = await supabase
        .from("event_log")
        .select("dedup_key, handler_status")
        .eq("pushpress_event", "reservation.created")
        .filter("payload->data->>id", "eq", res.id)
        .eq("handler_status", "success")
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error(`  ERROR query event_log for ${res.id}: ${error.message}`);
        continue;
      }
      if (!data) {
        gaps.push({ reservation: res, className: cls.title ?? cls.id, classStart: cls.start });
      }
    }
  }

  console.log(`[reservations] active reservations checked: ${activeChecked}`);
  console.log(`[reservations] gaps: ${gaps.length}`);
  for (const g of gaps) {
    const dt = new Date(g.classStart * 1000).toISOString();
    console.log(`  - ${g.reservation.id} on "${g.className}" @ ${dt}  customer=${g.reservation.customerId}`);
  }
  return gaps;
}

async function replayReservation(gap: ReservationGap): Promise<void> {
  const r = gap.reservation;

  // Replay needs to bypass the dedup gate. Mirrors the enrollment pattern:
  //
  // (1) Recover the original `created` from a prior event_log row when one
  //     exists — keeps dedup_key deterministic per reservation so subsequent
  //     replay runs of an unchanged reservation collide and return 'duplicate'
  //     (preventing accidental double-booking in Glofox).
  // (2) DELETE that prior row. Safe because gap detection has already proven
  //     no `success` row exists — only failed/filtered/skipped/duplicate.
  // (3) POST the synthetic webhook so the handler re-runs end-to-end.

  const { data: prior } = await supabase
    .from("event_log")
    .select("dedup_key, payload")
    .eq("pushpress_event", "reservation.created")
    .filter("payload->data->>id", "eq", r.id)
    .limit(1)
    .maybeSingle();

  let createdTs: number;
  if (prior?.payload && typeof prior.payload === "object") {
    const priorCreated = (prior.payload as { created?: unknown }).created;
    createdTs = typeof priorCreated === "number"
      ? priorCreated
      : r.registrationTimestamp;
    if (prior.dedup_key) {
      const { error } = await supabase
        .from("event_log")
        .delete()
        .eq("dedup_key", prior.dedup_key);
      if (error) {
        console.error(`    WARN: failed to delete prior event_log row: ${error.message}`);
      } else {
        console.log(`    deleted prior event_log row (will be replaced by replay)`);
      }
    }
  } else {
    createdTs = r.registrationTimestamp;
  }

  const body = {
    event: "reservation.created",
    created: createdTs,
    data: {
      id: r.id,
      reservedId: r.reservedId,
      customerId: r.customerId,
      companyId: r.companyId,
      registrationTimestamp: r.registrationTimestamp,
      status: r.status,
    },
  };
  const res = await postSyntheticWebhook(body);
  console.log(`    replayed: HTTP ${res.status} ${res.text}`);
}

// --- Enrollments audit ------------------------------------------------------

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

async function listActiveSaunaEnrollments(): Promise<PPEnrollment[]> {
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
  return out;
}

interface EnrollmentGap {
  enrollment: PPEnrollment;
}

async function auditEnrollments(): Promise<EnrollmentGap[]> {
  console.log(`\n[enrollments] all currently-active sauna enrollments`);
  console.log(`[enrollments] plan-category allowlist: ${SAUNA_PLAN_CATEGORIES.join(", ") || "<empty>"}`);

  const enrollments = await listActiveSaunaEnrollments();
  console.log(`[enrollments] sauna enrollments active: ${enrollments.length}`);

  const gaps: EnrollmentGap[] = [];
  for (const e of enrollments) {
    // Gap = no `success` event_log row for this enrollment's create.
    // Rows in handler_status=failed/filtered/skipped don't count as "mirrored"
    // — they're either drops or actively-needs-replay cases.
    const { data, error } = await supabase
      .from("event_log")
      .select("dedup_key, handler_status")
      .eq("pushpress_event", "enrollment.created")
      .filter("payload->data->>id", "eq", e.id)
      .eq("handler_status", "success")
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(`  ERROR query event_log for ${e.id}: ${error.message}`);
      continue;
    }
    if (!data) gaps.push({ enrollment: e });
  }

  console.log(`[enrollments] gaps: ${gaps.length}`);
  for (const g of gaps) {
    console.log(
      `  - ${g.enrollment.id} planId=${g.enrollment.planId} customer=${g.enrollment.customerId}`,
    );
  }
  return gaps;
}

async function replayEnrollment(gap: EnrollmentGap): Promise<void> {
  const e = gap.enrollment;

  // Replay needs to bypass the dedup gate. Two things to handle:
  //
  // (1) If a prior event_log row exists (e.g. handler_status='skipped' from
  //     before the enrollment handler was wired up), recover the original
  //     `created` timestamp from its payload, then DELETE the row. Deletion
  //     is safe because gap detection already ensured there is no 'success'
  //     row — only failed/filtered/skipped/duplicate/pending.
  //
  // (2) Use that recovered `created` (or a stable per-enrollment fallback)
  //     so dedup_key is deterministic per enrollment. Subsequent --replay
  //     runs of an unchanged enrollment will collide and return 'duplicate',
  //     preventing accidental double-assignment of Glofox memberships.

  const { data: prior } = await supabase
    .from("event_log")
    .select("dedup_key, payload")
    .eq("pushpress_event", "enrollment.created")
    .filter("payload->data->>id", "eq", e.id)
    .limit(1)
    .maybeSingle();

  let createdTs: number;
  if (prior?.payload && typeof prior.payload === "object") {
    const priorCreated = (prior.payload as { created?: unknown }).created;
    createdTs = typeof priorCreated === "number"
      ? priorCreated
      : enrollmentStartTs(e);
    if (prior.dedup_key) {
      const { error } = await supabase
        .from("event_log")
        .delete()
        .eq("dedup_key", prior.dedup_key);
      if (error) {
        console.error(`    WARN: failed to delete prior event_log row: ${error.message}`);
      } else {
        console.log(`    deleted prior event_log row (will be replaced by replay)`);
      }
    }
  } else {
    createdTs = enrollmentStartTs(e);
  }

  const body = {
    event: "enrollment.created",
    created: createdTs,
    data: {
      id: e.id,
      customerId: e.customerId,
      companyId: e.companyId,
      planId: e.planId,
      status: "active",
      startDate: e.startDate ?? null,
      billingSchedule: e.billingSchedule ?? { period: "month", interval: 1 },
    },
  };
  const res = await postSyntheticWebhook(body);
  console.log(`    replayed: HTTP ${res.status} ${res.text}`);
}

function enrollmentStartTs(e: PPEnrollment): number {
  // Stable per-enrollment timestamp — parses startDate to Unix seconds.
  // Falls back to 0 if startDate is missing/unparseable. The sentinel is
  // stable per enrollment.id, so re-running --replay produces the same
  // dedup_key and is idempotent.
  if (e.startDate) {
    const t = Date.parse(e.startDate);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  return 0;
}

// --- Main -------------------------------------------------------------------

console.log(`=== reconcile.ts mode=${mode} replay=${replay} ===`);

const allReservationGaps: ReservationGap[] = [];
const allEnrollmentGaps: EnrollmentGap[] = [];

if (mode === "reservations" || mode === "all") {
  const gaps = await auditReservations();
  allReservationGaps.push(
    ...(isOnlyFiltered ? gaps.filter((g) => onlyFilter.has(g.reservation.id)) : gaps),
  );
}
if (mode === "enrollments" || mode === "all") {
  const gaps = await auditEnrollments();
  allEnrollmentGaps.push(
    ...(isOnlyFiltered ? gaps.filter((g) => onlyFilter.has(g.enrollment.id)) : gaps),
  );
}

if (isOnlyFiltered) {
  console.log(
    `\n--only filter applied: ${onlyFilter.size} id(s) requested → ${allReservationGaps.length + allEnrollmentGaps.length} match(es)`,
  );
}

const totalGaps = allReservationGaps.length + allEnrollmentGaps.length;
console.log(`\n=== summary: ${totalGaps} gap(s) ===`);

if (totalGaps === 0) {
  console.log("✓ Reconciled — no gaps.");
  Deno.exit(0);
}

if (!replay) {
  console.log("Re-run with --replay to synthesize signed webhooks for these gaps.");
  Deno.exit(0);
}

console.log("\nReplaying...");
for (const g of allReservationGaps) {
  console.log(`  reservation ${g.reservation.id}:`);
  try {
    await replayReservation(g);
  } catch (err) {
    console.error(`    failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
for (const g of allEnrollmentGaps) {
  console.log(`  enrollment ${g.enrollment.id}:`);
  try {
    await replayEnrollment(g);
  } catch (err) {
    console.error(`    failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
