// groupon-rotate-cron — automated rotation for Groupon discount codes.
//
// Glofox caps each account at 100 discounts. TSG has 2 Groupon campaigns
// of 500 codes each (1000 total) but can only fit ~86 (43 G1 + 43 G2) in
// Glofox at a time. This cron:
//
//   1. Detects when a code has been redeemed (= its discount disappeared
//      from Glofox), marks it 'used' in groupon_codes
//   2. Refills each campaign to TARGET_PER_CAMPAIGN by uploading the next
//      queued code from groupon_codes (in CSV row order)
//   3. Records a run in groupon_rotation_runs for ops audit
//
// Auth: Bearer JWT from the Glofox DASHBOARD (not the public REST API).
// Expires every ~24h. The user must refresh it via:
//   deno run scripts/update-glofox-jwt.ts
// When it expires, the cron Slack-alerts and exits gracefully.
//
// See docs/glofox-groupon-bulk-upload.md for the broader workflow.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ============================================================================
// Config (env)
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const GLOFOX_JWT = Deno.env.get("GLOFOX_DASHBOARD_JWT") ?? "";
const GLOFOX_BRANCH = Deno.env.get("GLOFOX_BRANCH_ID") ?? "654e7d37c8a12ada310de13a";
const DASHBOARD_VERSION = Deno.env.get("GLOFOX_DASHBOARD_VERSION")
  ?? "dfe7f5ad7f36052b9199fa7b1de94acbf56d801a.202605112149";
const SLACK_URL = Deno.env.get("SLACK_OPS_WEBHOOK_URL") ?? "";

const TARGET_PER_CAMPAIGN = parseInt(
  Deno.env.get("GROUPON_TARGET_PER_CAMPAIGN") ?? "43",
  10,
);
const PACE_MS = 350; // pace API calls to be polite to dashboard internal API
const G1_PREFIX = "Groupon - ";
const G2_PREFIX = "Groupon 2 - ";

// Discount configs per campaign — must match what was uploaded historically
// or the dashboard will show inconsistent entries
const CAMPAIGN_CONFIG = {
  groupon_1: {
    name_prefix: G1_PREFIX,
    description: "Groupon - 1 Person",
    rate_value: 20000, // 20%
  },
  groupon_2: {
    name_prefix: G2_PREFIX,
    description: "Groupon for 2",
    rate_value: 25000, // 25%
  },
} as const;

const PROMO_CONFIG = {
  max_usage_limit: 1,
  usage_limit_per_user: 1,
  utc_start_date: "2026-05-12T00:00:00-04:00",
  utc_end_date: null,
  assignments: [{
    service_type: "memberships",
    include: [{
      service_id: "69d80c439f4158716c0068de", // Single Class Drop-in
      sub_service_ids: ["1775766556749"],
    }],
  }],
};

// ============================================================================
// Helpers
// ============================================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const GLOFOX_HEADERS: Record<string, string> = {
  "Authorization": `Bearer ${GLOFOX_JWT}`,
  "Content-Type": "application/json",
  "Accept": "application/json",
  "Origin": "https://app.glofox.com",
  "Referer": "https://app.glofox.com/dashboard/",
  "x-glofox-branch-id": GLOFOX_BRANCH,
  "x-glofox-branch-continent": "NA",
  "x-glofox-branch-timezone": "America/New_York",
  "x-glofox-source": "dashboard",
  "x-glofox-dashboard-page": "/discounts/definition",
  "x-glofox-dashboard-version": DASHBOARD_VERSION,
};

function decodeJwtExp(jwt: string): number | null {
  try {
    const [, payload] = jwt.split(".");
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

async function postSlack(text: string): Promise<void> {
  if (!SLACK_URL) return;
  try {
    await fetch(SLACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[tsg-cc-bridge] ${text}` }),
    });
  } catch (_err) {
    // best-effort
  }
}

interface Discount {
  id: string;
  name: string;
}

async function fetchAllDiscounts(): Promise<Discount[]> {
  const res = await fetch(
    "https://app.glofox.com/discount-api/v1/discounts",
    { headers: GLOFOX_HEADERS },
  );
  if (!res.ok) {
    throw new Error(`discounts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const d = await res.json();
  return d.discounts ?? d ?? [];
}

async function createDiscount(
  campaign: keyof typeof CAMPAIGN_CONFIG,
  code: string,
): Promise<string> {
  const cfg = CAMPAIGN_CONFIG[campaign];
  const url =
    `https://app.glofox.com/discount-api/v1/studios/${GLOFOX_BRANCH}/discounts`;
  const res = await fetch(url, {
    method: "POST",
    headers: GLOFOX_HEADERS,
    body: JSON.stringify({
      name: cfg.name_prefix + code,
      description: cfg.description,
      rate_value: cfg.rate_value,
      num_cycles: 0,
      rate_type: "percentage",
      applies_to_joining_fee_only: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`discount ${res.status}: ${text.slice(0, 200)}`);
  const obj = JSON.parse(text);
  if (!obj.id) throw new Error(`discount response missing id: ${text.slice(0, 200)}`);
  return obj.id;
}

async function createPromoCode(discountId: string, code: string): Promise<string> {
  const res = await fetch(
    "https://app.glofox.com/discount-api/v1/promo-codes",
    {
      method: "POST",
      headers: GLOFOX_HEADERS,
      body: JSON.stringify({
        discount_id: discountId,
        code,
        code_enabled: true,
        ...PROMO_CONFIG,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`promo-code ${res.status}: ${text.slice(0, 200)}`);
  const obj = JSON.parse(text);
  if (!obj.id) throw new Error(`promo-code response missing id: ${text.slice(0, 200)}`);
  return obj.id;
}

async function deleteDiscount(id: string): Promise<void> {
  await fetch(
    `https://app.glofox.com/discount-api/v1/discounts/${id}`,
    { method: "DELETE", headers: GLOFOX_HEADERS },
  );
  // Best-effort — orphan cleanup
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============================================================================
// Main rotation logic
// ============================================================================

interface GrouponCodeRow {
  code: string;
  campaign: "groupon_1" | "groupon_2";
  csv_row_index: number;
  status: string;
  glofox_discount_id: string | null;
  glofox_promo_code_id: string | null;
}

async function rotate(runId: string): Promise<{
  detected_used: number;
  attempted_uploads: number;
  successful_uploads: number;
  failed_uploads: number;
  per_campaign_state: Record<string, unknown>;
}> {
  // --- 1. Pull current Glofox state ---
  const discounts = await fetchAllDiscounts();

  // Map: discount_id -> name (for our Groupon-prefixed ones)
  const glofoxDiscountIds = new Set<string>();
  const glofoxCodesByName = new Set<string>();
  for (const d of discounts) {
    glofoxDiscountIds.add(d.id);
    if (d.name.startsWith(G2_PREFIX)) {
      glofoxCodesByName.add(d.name.slice(G2_PREFIX.length));
    } else if (d.name.startsWith(G1_PREFIX)) {
      glofoxCodesByName.add(d.name.slice(G1_PREFIX.length));
    }
  }

  // --- 2. Detection: codes marked 'uploaded' in DB whose discount is gone ---
  const { data: uploadedRows, error: ueErr } = await supabase
    .from("groupon_codes")
    .select("code, campaign, csv_row_index, status, glofox_discount_id, glofox_promo_code_id")
    .eq("status", "uploaded");
  if (ueErr) throw new Error(`select uploaded: ${ueErr.message}`);

  const usedCodes: string[] = [];
  for (const r of uploadedRows ?? []) {
    const row = r as GrouponCodeRow;
    const stillInGlofox = row.glofox_discount_id &&
      glofoxDiscountIds.has(row.glofox_discount_id);
    if (!stillInGlofox) {
      usedCodes.push(row.code);
    }
  }

  if (usedCodes.length > 0) {
    const { error } = await supabase
      .from("groupon_codes")
      .update({ status: "used", used_detected_at: new Date().toISOString() })
      .in("code", usedCodes);
    if (error) throw new Error(`mark used: ${error.message}`);
  }

  // --- 3. For each campaign, refill to TARGET ---
  const perCampaign: Record<string, {
    uploaded_count: number;
    needed: number;
    attempted: number;
    succeeded: number;
    failed: number;
    queued_remaining: number;
  }> = {};

  let totalAttempted = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;

  for (const campaign of ["groupon_1", "groupon_2"] as const) {
    // Current uploaded count
    const { count: uploadedCount } = await supabase
      .from("groupon_codes")
      .select("code", { count: "exact", head: true })
      .eq("status", "uploaded")
      .eq("campaign", campaign);

    const needed = Math.max(0, TARGET_PER_CAMPAIGN - (uploadedCount ?? 0));

    // Next queued codes by CSV row order
    const { data: queued, error: qErr } = await supabase
      .from("groupon_codes")
      .select("code, campaign, csv_row_index")
      .eq("status", "queued")
      .eq("campaign", campaign)
      .order("csv_row_index", { ascending: true })
      .limit(needed);
    if (qErr) throw new Error(`select queued ${campaign}: ${qErr.message}`);

    const { count: queuedTotal } = await supabase
      .from("groupon_codes")
      .select("code", { count: "exact", head: true })
      .eq("status", "queued")
      .eq("campaign", campaign);

    let succeeded = 0;
    let failed = 0;

    for (const row of queued ?? []) {
      const code = (row as { code: string }).code;
      let discountId: string | undefined;
      totalAttempted++;
      try {
        discountId = await createDiscount(campaign, code);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("groupon_codes")
          .update({
            status: "failed",
            failure_reason: `discount: ${msg.slice(0, 400)}`,
            failed_at: new Date().toISOString(),
          })
          .eq("code", code);
        failed++;
        totalFailed++;
        // Hard stop if we hit MAX_DISCOUNTS_REACHED or 401 — stop the whole run
        if (msg.includes("MAX_DISCOUNTS_REACHED") || msg.includes("401")) {
          perCampaign[campaign] = {
            uploaded_count: uploadedCount ?? 0,
            needed,
            attempted: succeeded + failed,
            succeeded,
            failed,
            queued_remaining: queuedTotal ?? 0,
          };
          throw new Error(`stop: ${msg.slice(0, 200)}`);
        }
        continue;
      }
      try {
        const promoCodeId = await createPromoCode(discountId, code);
        await supabase
          .from("groupon_codes")
          .update({
            status: "uploaded",
            glofox_discount_id: discountId,
            glofox_promo_code_id: promoCodeId,
            uploaded_at: new Date().toISOString(),
            failure_reason: null,
            failed_at: null,
          })
          .eq("code", code);
        succeeded++;
        totalSucceeded++;
      } catch (err) {
        // Orphan cleanup
        try { await deleteDiscount(discountId); } catch (_) { /* best-effort */ }
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("groupon_codes")
          .update({
            status: "failed",
            failure_reason: `promo: ${msg.slice(0, 400)} (orphan cleaned)`,
            failed_at: new Date().toISOString(),
          })
          .eq("code", code);
        failed++;
        totalFailed++;
      }
      // Pace the next call
      await new Promise((r) => setTimeout(r, PACE_MS));
    }

    perCampaign[campaign] = {
      uploaded_count: uploadedCount ?? 0,
      needed,
      attempted: succeeded + failed,
      succeeded,
      failed,
      queued_remaining: (queuedTotal ?? 0) - succeeded,
    };
  }

  return {
    detected_used: usedCodes.length,
    attempted_uploads: totalAttempted,
    successful_uploads: totalSucceeded,
    failed_uploads: totalFailed,
    per_campaign_state: perCampaign,
  };
}

// ============================================================================
// HTTP entry
// ============================================================================

Deno.serve(async (req) => {
  // Auth via Bearer CRON_SECRET (same pattern as reconcile-cron)
  if (!CRON_SECRET) {
    return new Response(
      JSON.stringify({ error: "CRON_SECRET not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (!constantTimeEquals(auth, `Bearer ${CRON_SECRET}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!GLOFOX_JWT) {
    await postSlack(
      "🚨 groupon-rotate-cron: GLOFOX_DASHBOARD_JWT not set. " +
        "Refresh via scripts/update-glofox-jwt.ts.",
    );
    return new Response(
      JSON.stringify({ error: "GLOFOX_DASHBOARD_JWT not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Check JWT expiry up front. Skip the run if expired or <5 min remaining.
  const exp = decodeJwtExp(GLOFOX_JWT);
  const jwtExpiresAt = exp ? new Date(exp * 1000).toISOString() : null;
  if (exp) {
    const secsLeft = exp - Math.floor(Date.now() / 1000);
    if (secsLeft <= 0) {
      await postSlack(
        "🚨 groupon-rotate-cron: GLOFOX_DASHBOARD_JWT expired. " +
          "Refresh via scripts/update-glofox-jwt.ts.",
      );
      const { data: r } = await supabase
        .from("groupon_rotation_runs")
        .insert({
          status: "jwt_expired",
          jwt_expires_at: jwtExpiresAt,
          completed_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      return new Response(
        JSON.stringify({ status: "jwt_expired", run_id: r?.id }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (secsLeft < 600) {
      await postSlack(
        `⚠️  groupon-rotate-cron: GLOFOX_DASHBOARD_JWT expires in ${
          Math.floor(secsLeft / 60)
        } min. Refresh soon.`,
      );
    }
  }

  // Start a run record
  const { data: runRec, error: runErr } = await supabase
    .from("groupon_rotation_runs")
    .insert({ status: "running", jwt_expires_at: jwtExpiresAt })
    .select("id")
    .single();
  if (runErr) {
    return new Response(
      JSON.stringify({ error: `cannot start run: ${runErr.message}` }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  const runId = runRec.id as string;

  try {
    const result = await rotate(runId);
    const finalStatus = (result.detected_used === 0 && result.attempted_uploads === 0)
      ? "no_op"
      : "success";
    await supabase
      .from("groupon_rotation_runs")
      .update({
        status: finalStatus,
        completed_at: new Date().toISOString(),
        detected_used: result.detected_used,
        attempted_uploads: result.attempted_uploads,
        successful_uploads: result.successful_uploads,
        failed_uploads: result.failed_uploads,
        per_campaign_state: result.per_campaign_state,
      })
      .eq("id", runId);

    // Slack alert only when something actually happened
    if (result.detected_used > 0 || result.successful_uploads > 0 || result.failed_uploads > 0) {
      await postSlack(
        `groupon-rotate-cron: detected ${result.detected_used} used, ` +
          `uploaded ${result.successful_uploads}, failed ${result.failed_uploads}`,
      );
    }

    return new Response(
      JSON.stringify({
        run_id: runId,
        status: finalStatus,
        ...result,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from("groupon_rotation_runs")
      .update({
        status: "error",
        completed_at: new Date().toISOString(),
        error_message: msg.slice(0, 1000),
      })
      .eq("id", runId);
    await postSlack(`🚨 groupon-rotate-cron error: ${msg.slice(0, 300)}`);
    return new Response(
      JSON.stringify({ run_id: runId, status: "error", error: msg.slice(0, 300) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
});
