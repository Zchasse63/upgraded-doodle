// Balance Groupon-1 and Groupon-2 discount counts under Glofox's 100-cap.
//
// Glofox limits each account to 100 total discounts. TSG has 13 non-Groupon
// discounts that MUST be preserved (Trents Discount Code, NOEQL, etc.).
// That leaves 87 slots for Groupon. To keep both campaigns equal, we
// target 43 of each (= 86, with 1 slot of headroom).
//
// CURRENT (as of analysis time):
//   Groupon-1: 79  → DELETE 36 to reach 43
//   Groupon-2:  8  → UPLOAD 35 more to reach 43
//
// Strategy for which to delete from Groupon-1:
//   Keep the EARLIEST CSV rows uploaded (positions 1..N). Delete the
//   LATEST positions among those already uploaded. That way both CSVs end
//   up with a clean "rows 1..43 uploaded" boundary — easy for ops to
//   reason about and re-resume later if the cap is raised.
//
// CSV markup:
//   Adds a `GlofoxStatus` column to each CSV. Two values only:
//     "uploaded"     — discount + promo-code currently exist in Glofox
//     "not_uploaded" — currently NOT in Glofox (never uploaded, OR was
//                       uploaded earlier and removed to free capacity)
//   The full history (which codes were created, deleted, etc.) lives in
//   the `scripts/balance-results-*.json` audit files.
//
// Usage:
//   deno run --allow-net --allow-read --allow-env --allow-write \
//     scripts/balance-groupon-discounts.ts            # dry-run / plan
//   deno run --allow-net --allow-read --allow-env --allow-write \
//     scripts/balance-groupon-discounts.ts --execute  # actually do it

import { TextLineStream } from "https://deno.land/std@0.224.0/streams/text_line_stream.ts";

// ============================================================================
// CONFIG
// ============================================================================

const JWT = Deno.env.get("GLOFOX_DASHBOARD_JWT") ?? "";
const STUDIO_ID = Deno.env.get("GLOFOX_BRANCH_ID") ?? "654e7d37c8a12ada310de13a";
const DASHBOARD_VERSION = Deno.env.get("GLOFOX_DASHBOARD_VERSION")
  ?? "dfe7f5ad7f36052b9199fa7b1de94acbf56d801a.202605112149";

const TOTAL_CAP = 100;
const SAFETY_HEADROOM = 1; // leave N slots unused so adding 1 manual discount doesn't break
const TARGET_PER_GROUPON = 43; // hardcoded after math: (100 - 13 other - 1 headroom) / 2

const G1_CSV = "scripts/groupon-1-codes.csv";
const G2_CSV = "scripts/groupon-2-codes.csv";

// Groupon-1 discount config (1-person, 20% off)
const G1_DISCOUNT = {
  name_prefix: "Groupon - ",
  description: "Groupon - 1 Person",
  rate_value: 20000, // 20.000%
};

// Groupon-2 discount config (2-person, 25% off)
const G2_DISCOUNT = {
  name_prefix: "Groupon 2 - ",
  description: "Groupon for 2",
  rate_value: 25000, // 25.000%
};

// Shared promo-code config (same for both campaigns)
const PROMO_CONFIG = {
  max_usage_limit: 1,
  usage_limit_per_user: 1,
  utc_start_date: "2026-05-12T00:00:00-04:00",
  utc_end_date: null,
  assignments: [
    {
      service_type: "memberships",
      include: [
        {
          service_id: "69d80c439f4158716c0068de", // Single Class Drop-in
          sub_service_ids: ["1775766556749"],
        },
      ],
    },
  ],
};

const PACE_MS = 350;
const EXECUTE = Deno.args.includes("--execute");

// ============================================================================
// IMPLEMENTATION
// ============================================================================

if (!JWT) {
  console.error("error: GLOFOX_DASHBOARD_JWT not set");
  Deno.exit(1);
}

const HEADERS: Record<string, string> = {
  "Authorization": `Bearer ${JWT}`,
  "Content-Type": "application/json",
  "Accept": "application/json",
  "Origin": "https://app.glofox.com",
  "Referer": "https://app.glofox.com/dashboard/",
  "x-glofox-branch-id": STUDIO_ID,
  "x-glofox-branch-continent": "NA",
  "x-glofox-branch-timezone": "America/New_York",
  "x-glofox-source": "dashboard",
  "x-glofox-dashboard-page": "/discounts/definition",
  "x-glofox-dashboard-version": DASHBOARD_VERSION,
};

interface CsvRow {
  Code: string;
  Status: string;
  External_User_Redemption_Url: string;
  External_Redemption_Url: string;
  GlofoxStatus?: string;
}

async function readCsv(path: string): Promise<CsvRow[]> {
  const text = await Deno.readTextFile(path);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headerParts = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const parts = line.split(",");
    const row: Record<string, string> = {};
    for (let i = 0; i < headerParts.length; i++) {
      row[headerParts[i]] = parts[i] ?? "";
    }
    return row as unknown as CsvRow;
  });
}

async function writeCsv(path: string, rows: CsvRow[]): Promise<void> {
  const header = "Code,Status,External_User_Redemption_Url,External_Redemption_Url,GlofoxStatus";
  const body = rows.map((r) =>
    [r.Code, r.Status, r.External_User_Redemption_Url, r.External_Redemption_Url, r.GlofoxStatus ?? "not_uploaded"]
      .join(",")
  ).join("\n");
  await Deno.writeTextFile(path, header + "\n" + body + "\n");
}

interface Discount {
  id: string;
  name: string;
  description?: string;
  rate_type?: string;
  rate_value?: number;
}

async function fetchAllDiscounts(): Promise<Discount[]> {
  const res = await fetch("https://app.glofox.com/discount-api/v1/discounts", { headers: HEADERS });
  if (!res.ok) throw new Error(`fetchAllDiscounts ${res.status}`);
  const d = await res.json();
  return d.discounts ?? d;
}

async function createDiscount(name: string, description: string, rate_value: number): Promise<string> {
  const url = `https://app.glofox.com/discount-api/v1/studios/${STUDIO_ID}/discounts`;
  const res = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name,
      description,
      rate_value,
      num_cycles: 0,
      rate_type: "percentage",
      applies_to_joining_fee_only: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`discounts ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).id;
}

async function createPromoCode(discount_id: string, code: string): Promise<string> {
  const res = await fetch("https://app.glofox.com/discount-api/v1/promo-codes", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ discount_id, code, code_enabled: true, ...PROMO_CONFIG }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`promo-codes ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).id;
}

async function deleteDiscount(id: string): Promise<void> {
  // Verified 2026-05-12: the delete endpoint is `/discount-api/v1/discounts/{id}`
  // (NO studio path segment, despite the create path having one). The
  // studio-scoped path returns 405 Method Not Allowed for DELETE.
  const url = `https://app.glofox.com/discount-api/v1/discounts/${id}`;
  const res = await fetch(url, { method: "DELETE", headers: HEADERS });
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete ${id} ${res.status}: ${await res.text()}`);
  }
}

function extractCode(name: string, prefix: string): string | null {
  return name.startsWith(prefix) ? name.slice(prefix.length).trim() : null;
}

// --- Phase 1: Read state ---

console.error("Reading CSVs…");
const g1Rows = await readCsv(G1_CSV);
const g2Rows = await readCsv(G2_CSV);
console.error(`  ${G1_CSV}: ${g1Rows.length} codes`);
console.error(`  ${G2_CSV}: ${g2Rows.length} codes`);

console.error("Querying Glofox discount state…");
const allDiscounts = await fetchAllDiscounts();
console.error(`  total discounts in Glofox: ${allDiscounts.length}`);

const g1Existing = new Map<string, Discount>();
const g2Existing = new Map<string, Discount>();
const otherExisting: Discount[] = [];
for (const d of allDiscounts) {
  const g1code = extractCode(d.name, G1_DISCOUNT.name_prefix);
  const g2code = extractCode(d.name, G2_DISCOUNT.name_prefix);
  if (g2code) g2Existing.set(g2code, d);
  else if (g1code) g1Existing.set(g1code, d);
  else otherExisting.push(d);
}

console.error(`  Groupon-1 uploaded: ${g1Existing.size}`);
console.error(`  Groupon-2 uploaded: ${g2Existing.size}`);
console.error(`  Other (must keep): ${otherExisting.length}`);

// --- Phase 2: Plan deletions and uploads ---

// G1 deletions: keep the first TARGET_PER_GROUPON of g1Rows that are already
// uploaded; delete the rest of the uploaded ones.
const g1UploadedInCsvOrder: { row: CsvRow; index: number; discountId: string }[] = [];
g1Rows.forEach((r, i) => {
  const d = g1Existing.get(r.Code);
  if (d) g1UploadedInCsvOrder.push({ row: r, index: i, discountId: d.id });
});

// Also: any G1 in Glofox that's NOT in the CSV — keep those? Or delete?
// Safer: leave them alone, they may be manual creations.
const g1InCsvCodes = new Set(g1Rows.map((r) => r.Code));
const g1NotInCsv = [...g1Existing.entries()].filter(([code]) => !g1InCsvCodes.has(code));
if (g1NotInCsv.length > 0) {
  console.error(`  ⚠️  ${g1NotInCsv.length} Groupon-1 entries in Glofox are NOT in the CSV — these will be kept untouched`);
  for (const [code] of g1NotInCsv.slice(0, 5)) console.error(`     - ${code}`);
}

const g1KeepCount = Math.max(0, TARGET_PER_GROUPON - g1NotInCsv.length);
const g1ToKeep = g1UploadedInCsvOrder.slice(0, g1KeepCount);
const g1ToDelete = g1UploadedInCsvOrder.slice(g1KeepCount);

// G2 uploads: target TARGET_PER_GROUPON total, skipping ones already in Glofox
const g2NeedCount = Math.max(0, TARGET_PER_GROUPON - g2Existing.size);
const g2ToUpload: CsvRow[] = [];
for (const r of g2Rows) {
  if (g2ToUpload.length >= g2NeedCount) break;
  if (g2Existing.has(r.Code)) continue;
  g2ToUpload.push(r);
}

// --- Phase 3: Show plan ---

// Net change to Glofox's total = -deletes +uploads. Use the actual
// Glofox total as the baseline (avoids any double-counting in our
// categorization, which can miss off-pattern names).
const projectedTotal = allDiscounts.length - g1ToDelete.length + g2ToUpload.length;

console.error(`
=== BALANCE PLAN ===
Mode:             ${EXECUTE ? "EXECUTE (will write to Glofox)" : "DRY-RUN (no changes)"}
Target per side:  ${TARGET_PER_GROUPON}
Headroom:         ${SAFETY_HEADROOM}
Cap:              ${TOTAL_CAP}

Currently:
  Other:              ${otherExisting.length}  (untouchable)
  Groupon-1 in CSV:   ${g1Existing.size - g1NotInCsv.length}
  Groupon-1 manual:   ${g1NotInCsv.length}  (kept — not in CSV)
  Groupon-2:          ${g2Existing.size}
  Total:              ${allDiscounts.length}

Actions:
  G1 DELETE:          ${g1ToDelete.length}  (last in CSV order, kept first ${g1KeepCount})
  G2 UPLOAD:          ${g2ToUpload.length}

After plan:
  Other:              ${otherExisting.length}
  Groupon-1:          ${g1Existing.size - g1ToDelete.length}
  Groupon-2:          ${g2Existing.size + g2ToUpload.length}
  Total:              ${projectedTotal}  (cap is ${TOTAL_CAP})

ETA:              ~${Math.ceil((g1ToDelete.length + g2ToUpload.length * 2) * PACE_MS / 1000 / 60)} min
`);

if (!EXECUTE) {
  console.error("(dry-run; re-run with --execute to perform deletions + uploads)");
  // Even on dry-run, write updated CSVs that REFLECT THE PROPOSED PLAN
  // — gives the user a way to preview what the CSVs will look like.
}

// --- Phase 4: Execute (if requested) ---

interface ActionLog {
  action: "delete_g1" | "upload_g2";
  code: string;
  ok: boolean;
  error?: string;
  discount_id?: string;
  promo_code_id?: string;
}
const log: ActionLog[] = [];

if (EXECUTE) {
  console.error("\n--- Phase 4a: Deleting excess Groupon-1 discounts ---");
  for (let i = 0; i < g1ToDelete.length; i++) {
    const { row, discountId } = g1ToDelete[i];
    try {
      await deleteDiscount(discountId);
      log.push({ action: "delete_g1", code: row.Code, ok: true, discount_id: discountId });
      console.log(`[del ${i + 1}/${g1ToDelete.length}] ✓ ${row.Code}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push({ action: "delete_g1", code: row.Code, ok: false, discount_id: discountId, error: msg });
      console.log(`[del ${i + 1}/${g1ToDelete.length}] ✗ ${row.Code} — ${msg}`);
      if (msg.includes("401")) {
        console.error("\n401 — JWT expired. Stopping.");
        break;
      }
    }
    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  console.error("\n--- Phase 4b: Uploading new Groupon-2 discounts ---");
  for (let i = 0; i < g2ToUpload.length; i++) {
    const row = g2ToUpload[i];
    const code = row.Code;
    try {
      const discountId = await createDiscount(
        G2_DISCOUNT.name_prefix + code,
        G2_DISCOUNT.description,
        G2_DISCOUNT.rate_value,
      );
      try {
        const promoCodeId = await createPromoCode(discountId, code);
        log.push({ action: "upload_g2", code, ok: true, discount_id: discountId, promo_code_id: promoCodeId });
        console.log(`[upl ${i + 1}/${g2ToUpload.length}] ✓ ${code}`);
      } catch (err) {
        await deleteDiscount(discountId).catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        log.push({ action: "upload_g2", code, ok: false, discount_id: discountId, error: `promo: ${msg} (orphan cleaned)` });
        console.log(`[upl ${i + 1}/${g2ToUpload.length}] ✗ ${code} — promo: ${msg} (orphan cleaned)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push({ action: "upload_g2", code, ok: false, error: msg });
      console.log(`[upl ${i + 1}/${g2ToUpload.length}] ✗ ${code} — ${msg}`);
      if (msg.includes("MAX_DISCOUNTS_REACHED") || msg.includes("401")) {
        console.error(`\nStopping early: ${msg}`);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, PACE_MS));
  }
}

// --- Phase 5: Update CSVs ---

const deletedG1Codes = new Set(
  log.filter((l) => l.action === "delete_g1" && l.ok).map((l) => l.code),
);
const uploadedG2Codes = new Set(
  log.filter((l) => l.action === "upload_g2" && l.ok).map((l) => l.code),
);

// CSV updates reflect CURRENT actual state only, never projections.
// Dry-run mode skips writing entirely so we don't claim "deleted" when
// nothing was actually deleted.
if (EXECUTE) {
  // Status = "currently in Glofox" — only 2 values: uploaded / not_uploaded.
  // Codes we deleted in this run flip back to "not_uploaded".
  // Full action history is in the balance-results audit JSON.
  for (const r of g1Rows) {
    r.GlofoxStatus = g1Existing.has(r.Code) && !deletedG1Codes.has(r.Code)
      ? "uploaded"
      : "not_uploaded";
  }
  for (const r of g2Rows) {
    r.GlofoxStatus = g2Existing.has(r.Code) || uploadedG2Codes.has(r.Code)
      ? "uploaded"
      : "not_uploaded";
  }
  await writeCsv(G1_CSV, g1Rows);
  await writeCsv(G2_CSV, g2Rows);
}

// Audit log
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const auditPath = `scripts/balance-results-${stamp}.json`;
await Deno.writeTextFile(
  auditPath,
  JSON.stringify({
    started_at: new Date().toISOString(),
    executed: EXECUTE,
    g1_to_delete: g1ToDelete.length,
    g2_to_upload: g2ToUpload.length,
    actions: log,
  }, null, 2),
);

const okCount = log.filter((l) => l.ok).length;
const failCount = log.filter((l) => !l.ok).length;
console.log(`\n${EXECUTE ? "Done" : "Dry-run done"}: ${okCount} ok / ${failCount} failed`);
console.log(`Audit: ${auditPath}`);
if (EXECUTE) {
  console.log(`CSVs updated: ${G1_CSV}, ${G2_CSV}`);
} else {
  console.log(`(dry-run — CSVs NOT modified; re-run with --execute to apply)`);
}
