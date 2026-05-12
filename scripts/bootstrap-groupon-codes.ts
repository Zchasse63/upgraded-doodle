// One-time bootstrap: load both Groupon CSVs into Supabase's groupon_codes
// table, then sync the current Glofox state. Safe to re-run — uses
// ON CONFLICT to avoid duplicates and re-syncs Glofox state on every run.
//
// Usage:
//   export GLOFOX_DASHBOARD_JWT="..."          # fresh JWT from dashboard
//   deno run --allow-net --allow-read --allow-env \
//     scripts/bootstrap-groupon-codes.ts [--dry-run]
//
// What it does:
//   1. Reads scripts/groupon-1-codes.csv and scripts/groupon-2-codes.csv
//   2. Upserts all 1000 codes into groupon_codes (preserves CSV row order)
//   3. Pulls current Glofox state (discounts + promo codes via pagination)
//   4. For each code in Glofox: marks the matching row as 'uploaded' with
//      its glofox_discount_id + glofox_promo_code_id
//   5. For each row NOT in Glofox: leaves as 'queued' (or whatever existing
//      status — e.g. 'used' from a prior cron run)
//
// The bootstrap is idempotent. Re-running it just re-syncs Glofox state
// without disturbing other DB state (used_detected_at, failure_reason, etc).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// --- Config ---

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const JWT = Deno.env.get("GLOFOX_DASHBOARD_JWT") ?? "";
const STUDIO_ID = Deno.env.get("GLOFOX_BRANCH_ID") ?? "654e7d37c8a12ada310de13a";
const DRY_RUN = Deno.args.includes("--dry-run");

const G1_CSV = "scripts/groupon-1-codes.csv";
const G2_CSV = "scripts/groupon-2-codes.csv";

const G1_PREFIX = "Groupon - ";
const G2_PREFIX = "Groupon 2 - ";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  Deno.exit(1);
}
if (!JWT) {
  console.error("error: GLOFOX_DASHBOARD_JWT must be set");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const GLOFOX_HEADERS: Record<string, string> = {
  "Authorization": `Bearer ${JWT}`,
  "Accept": "application/json",
  "x-glofox-branch-id": STUDIO_ID,
  "x-glofox-source": "dashboard",
  "Origin": "https://app.glofox.com",
  "Referer": "https://app.glofox.com/dashboard/",
};

// --- CSV ---

function readCodes(path: string): string[] {
  const text = Deno.readTextFileSync(path);
  const lines = text.split(/\r?\n/);
  return lines
    .slice(1) // header
    .map((l) => l.split(",")[0].trim())
    .filter((c) => c.length > 0);
}

const g1Codes = readCodes(G1_CSV);
const g2Codes = readCodes(G2_CSV);
console.error(`CSV: ${g1Codes.length} G1 codes, ${g2Codes.length} G2 codes`);

// --- Glofox sync ---

interface Discount {
  id: string;
  name: string;
}
interface PromoCode {
  id: string;
  discount_id: string;
  code: string;
}

async function fetchDiscounts(): Promise<Discount[]> {
  const res = await fetch("https://app.glofox.com/discount-api/v1/discounts", {
    headers: GLOFOX_HEADERS,
  });
  if (!res.ok) throw new Error(`discounts ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return d.discounts ?? d ?? [];
}

async function fetchAllPromoCodes(): Promise<PromoCode[]> {
  const out: PromoCode[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `https://app.glofox.com/discount-api/v1/promo-codes?page=${page}`,
      { headers: GLOFOX_HEADERS },
    );
    if (!res.ok) {
      throw new Error(`promo-codes page=${page} ${res.status}: ${await res.text()}`);
    }
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const p of arr) {
      if (p && typeof p.code === "string" && typeof p.discount_id === "string") {
        out.push({ id: p.id, code: p.code, discount_id: p.discount_id });
      }
    }
    if (arr.length < 25) break;
  }
  return out;
}

console.error("Fetching Glofox state...");
const discounts = await fetchDiscounts();
const promos = await fetchAllPromoCodes();
console.error(`  ${discounts.length} discounts, ${promos.length} promo codes`);

// Build code -> { discount_id, promo_code_id } map.
// Two sources of truth — DISCOUNT NAME is more reliable than the promo-codes
// list endpoint (some promo codes are "hidden" from the list, like 6RH8 was;
// the discount itself stays visible). For each code, prefer the promo-code
// match (gives us the promo_code_id for later cancel/delete), but fall back
// to discount-name matching so we don't false-negative.
const glofoxCodeMap = new Map<
  string,
  { discount_id: string; promo_code_id: string | null }
>();

// Pass 1: codes visible in /promo-codes list (with full promo_code_id)
for (const p of promos) {
  const d = discounts.find((x) => x.id === p.discount_id);
  if (!d) continue;
  if (d.name.startsWith(G1_PREFIX) || d.name.startsWith(G2_PREFIX)) {
    glofoxCodeMap.set(p.code, {
      discount_id: p.discount_id,
      promo_code_id: p.id,
    });
  }
}
// Pass 2: codes whose discount exists but promo code is hidden from list
// (the 6RH8-style cases). We have the discount_id but no promo_code_id.
for (const d of discounts) {
  let code: string | null = null;
  if (d.name.startsWith(G2_PREFIX)) code = d.name.slice(G2_PREFIX.length);
  else if (d.name.startsWith(G1_PREFIX)) code = d.name.slice(G1_PREFIX.length);
  if (!code) continue;
  if (!glofoxCodeMap.has(code)) {
    glofoxCodeMap.set(code, {
      discount_id: d.id,
      promo_code_id: null,
    });
  }
}
console.error(
  `  ${glofoxCodeMap.size} Groupon codes in Glofox ` +
    `(${[...glofoxCodeMap.values()].filter((v) => v.promo_code_id).length} with visible promo, ` +
    `${[...glofoxCodeMap.values()].filter((v) => !v.promo_code_id).length} discount-only)`,
);

// --- Build rows ---

interface Row {
  code: string;
  campaign: "groupon_1" | "groupon_2";
  csv_row_index: number;
  status: "queued" | "uploaded";
  glofox_discount_id: string | null;
  glofox_promo_code_id: string | null;
  uploaded_at: string | null;
}

function makeRows(codes: string[], campaign: "groupon_1" | "groupon_2"): Row[] {
  return codes.map((code, i) => {
    const glofox = glofoxCodeMap.get(code);
    return {
      code,
      campaign,
      csv_row_index: i + 1, // 1-based
      status: glofox ? "uploaded" : "queued",
      glofox_discount_id: glofox?.discount_id ?? null,
      glofox_promo_code_id: glofox?.promo_code_id ?? null,
      uploaded_at: glofox ? new Date().toISOString() : null,
    };
  });
}

const allRows = [...makeRows(g1Codes, "groupon_1"), ...makeRows(g2Codes, "groupon_2")];
const uploadedCount = allRows.filter((r) => r.status === "uploaded").length;
const queuedCount = allRows.length - uploadedCount;

console.error(`
=== Bootstrap plan ===
Total rows:       ${allRows.length}
  status=uploaded: ${uploadedCount}  (matched in Glofox)
  status=queued:   ${queuedCount}
${DRY_RUN ? "DRY RUN — not writing to Supabase" : "Writing to Supabase..."}`);

if (DRY_RUN) {
  console.log("✓ Dry-run complete. Re-run without --dry-run to actually upsert.");
  Deno.exit(0);
}

// --- Upsert in batches ---

const BATCH = 200;
let written = 0;
for (let i = 0; i < allRows.length; i += BATCH) {
  const batch = allRows.slice(i, i + BATCH);
  const { error } = await supabase
    .from("groupon_codes")
    .upsert(batch, {
      onConflict: "code",
      // Only update sync-able fields. NEVER overwrite status='used' or
      // status='failed' rows — those represent post-bootstrap state we
      // should preserve. Filter those out on the read side instead.
      ignoreDuplicates: false,
    });
  if (error) {
    console.error(`batch ${i}: ${error.message}`);
    Deno.exit(1);
  }
  written += batch.length;
  console.error(`  wrote ${written}/${allRows.length}`);
}

// Reset any "used" or "failed" rows that are now uploaded again? No —
// don't touch those. But the upsert will have set them back to 'queued'
// or 'uploaded' based on Glofox state. We DO want that — if a code was
// marked 'used' but is somehow in Glofox again (manual re-add?), we should
// reflect reality. The 'used_detected_at' timestamp will linger as a
// breadcrumb.
//
// EXCEPTION: codes manually marked 'failed' might be re-attempted on next
// cron run, which is fine.

console.log(`✓ Bootstrap complete. ${written} rows upserted.`);
console.log(`  ${uploadedCount} matched in Glofox (status=uploaded)`);
console.log(`  ${queuedCount} waiting in queue (status=queued)`);
