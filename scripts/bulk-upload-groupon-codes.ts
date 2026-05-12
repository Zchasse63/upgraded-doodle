// Bulk-upload Groupon discount codes into TSG's Glofox via the
// dashboard's internal API (app.glofox.com/discount-api/v1).
//
// This is a workaround for two limitations:
//   1. The public Glofox REST API has NO endpoints for creating discounts
//      or promo codes. Verified via the OpenAPI 3.1 spec at
//      apidocs-plat.aws.glofox.com — only consumption (apply at purchase
//      time) is exposed publicly.
//   2. The Glofox dashboard supports creating one discount at a time
//      manually, and their devs confirmed there's no bulk-import tool.
//
// The workaround: replay the same HTTP calls the dashboard makes when
// you click "Create discount" → "Create promo code". Capture the calls
// in Safari/Chrome DevTools, paste the auth into this script, run.
//
// Each Groupon code becomes a Discount + Promo Code pair:
//   POST /discount-api/v1/studios/{studioId}/discounts → returns discount.id
//   POST /discount-api/v1/promo-codes  body includes discount_id from step 1
//
// Auth: the dashboard uses Bearer JWT (expires ~24hrs from login) plus
// some x-glofox-* headers + cookies. Grab a fresh curl in DevTools right
// before running.
//
// ============================================================================
// USAGE
// ============================================================================
//
//   # 1. Put your codes in scripts/groupon-codes.txt (one code per line):
//   #    GROUPON-001
//   #    GROUPON-002
//   #    ...
//
//   # 2. Edit the CONFIG block below to match what you want each discount
//   #    to look like.
//
//   # 3. Grab a fresh JWT from the Glofox dashboard:
//   #    a. Log into app.glofox.com/dashboard
//   #    b. Open DevTools → Network tab → Fetch/XHR filter
//   #    c. Navigate to any page (e.g., Discounts)
//   #    d. Right-click any app.glofox.com request → Copy as cURL
//   #    e. Extract the Authorization Bearer value from the curl
//   #    f. Set GLOFOX_DASHBOARD_JWT below (or via env var)
//
//   # 4. (Optional) Set GLOFOX_DASHBOARD_VERSION below to whatever the
//   #    captured curl shows for x-glofox-dashboard-version. The internal
//   #    API may reject calls without this when they bump the dashboard
//   #    build. Default is a known-working value from 2026-05-12.
//
//   # 5. Dry-run first (uploads NOTHING — just prints what would happen):
//   #    deno run --allow-net --allow-read --allow-env \
//   #      scripts/bulk-upload-groupon-codes.ts --dry-run
//
//   # 6. Test with a tiny sample first (e.g., 2 codes):
//   #    deno run --allow-net --allow-read --allow-env \
//   #      scripts/bulk-upload-groupon-codes.ts --limit 2
//
//   # 7. Verify those 2 appear correctly in the Glofox dashboard. Delete
//   #    them manually if needed (the dashboard has a delete button).
//
//   # 8. Full run:
//   #    deno run --allow-net --allow-read --allow-env \
//   #      scripts/bulk-upload-groupon-codes.ts
//
//   # 9. After the run, scripts/groupon-upload-results.json has the full
//   #    audit log: which codes succeeded, which failed, and the new
//   #    discount UUIDs (so you can roll back via the dashboard if needed).
//
// ============================================================================

// ============================================================================
// CONFIG — EDIT THESE BEFORE RUNNING
// ============================================================================

// JWT from the Glofox dashboard. Expires ~24hrs after capture.
// Either paste here or export GLOFOX_DASHBOARD_JWT="..." before running.
const GLOFOX_DASHBOARD_JWT = Deno.env.get("GLOFOX_DASHBOARD_JWT") ?? "";

// Studio / branch ID. Same as your GLOFOX_BRANCH_ID env var. The dashboard
// puts this in both the URL path and the x-glofox-branch-id header.
const STUDIO_ID = Deno.env.get("GLOFOX_BRANCH_ID") ?? "654e7d37c8a12ada310de13a";

// Dashboard version. Captured 2026-05-12. If the script suddenly starts
// returning 400s after a Glofox dashboard release, grab a fresh curl and
// update this string.
const GLOFOX_DASHBOARD_VERSION = Deno.env.get("GLOFOX_DASHBOARD_VERSION")
  ?? "dfe7f5ad7f36052b9199fa7b1de94acbf56d801a.202605112149";

// --- Discount config (applied identically to every code in the file) ----
// Matches the "Groupon 2 - {code}" pattern: 25% off Single Class Drop-in,
// single-use per code, single-use per customer, no end date.

const DISCOUNT_NAME_PATTERN = (code: string) => `Groupon 2 - ${code}`;
const DISCOUNT_DESCRIPTION = "Groupon for 2";

// rate_type: "percentage" or "fixed"
// rate_value is scaled by 1000:
//   percentage: 25000 = 25.000% off, 100000 = 100.000% off (free)
//   fixed:      2000  = $2.00 off (cents × 100)
const DISCOUNT_RATE_TYPE: "percentage" | "fixed" = "percentage";
const DISCOUNT_RATE_VALUE = 25000; // 25% off

// num_cycles: 0 = applies to all recurring membership payments
//             N = applies only to the first N cycles
const DISCOUNT_NUM_CYCLES = 0;
const DISCOUNT_APPLIES_TO_JOINING_FEE_ONLY = false;

// --- Promo code config --------------------------------------------------

const PROMO_MAX_USAGE_LIMIT = 1; // total times this code can be used (1 = single-use)
const PROMO_USAGE_LIMIT_PER_USER = 1; // per-customer limit
const PROMO_UTC_START_DATE = "2026-05-12T00:00:00-04:00"; // when the code becomes valid
const PROMO_UTC_END_DATE: string | null = null; // expiry — null = never

// Which Glofox memberships the discount applies to. Each entry =
// one membership with optional plan-code restrictions. Find these by:
//   - service_id: GET /2.0/memberships?private=any returns _id per membership
//   - sub_service_ids: the plan codes within that membership (NOEQL has 3)
//
// Examples:
//   "Single Class Drop-in" (69d80c439f4158716c0068de) with plan 1775766556749
//   NOEQL (69fe0e2c238a9b2cd206fa15) with one of the 3 NOEQL plan codes
const PROMO_ASSIGNMENTS = [
  {
    service_type: "memberships" as const,
    include: [
      {
        service_id: "69d80c439f4158716c0068de", // Single Class Drop-in
        sub_service_ids: ["1775766556749"],
      },
    ],
  },
];

// --- Operational --------------------------------------------------------

// Codes file. Either .txt (one code per line) or .csv (one code per row,
// first column used; optional header row auto-detected and skipped if
// not all-uppercase-alphanumeric).
const CODES_FILE = Deno.env.get("CODES_FILE") ?? "scripts/groupon-codes.csv";
const RESULTS_FILE = "scripts/groupon-upload-results.json";
const PACE_MS = 350; // ~3 calls/sec — internal API rate limits unknown, be polite

// ============================================================================
// IMPLEMENTATION — usually no edits needed below
// ============================================================================

interface UploadResult {
  code: string;
  ok: boolean;
  discount_id?: string;
  promo_code_id?: string;
  error?: string;
  duration_ms: number;
}

const args = Deno.args;
const DRY_RUN = args.includes("--dry-run");
const LIMIT_IDX = args.indexOf("--limit");
const LIMIT = LIMIT_IDX >= 0 ? parseInt(args[LIMIT_IDX + 1], 10) : Infinity;

function bail(msg: string): never {
  console.error(`error: ${msg}`);
  Deno.exit(1);
}

if (!GLOFOX_DASHBOARD_JWT) {
  bail(
    "GLOFOX_DASHBOARD_JWT is not set. See the USAGE block at the top of this file.",
  );
}

// Decode JWT to check expiry and warn if it's close
function decodeJwtExp(jwt: string): number | null {
  try {
    const [, payload] = jwt.split(".");
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}
const exp = decodeJwtExp(GLOFOX_DASHBOARD_JWT);
if (exp) {
  const secsLeft = exp - Math.floor(Date.now() / 1000);
  if (secsLeft <= 0) bail("JWT has already expired. Grab a fresh one.");
  if (secsLeft < 600) {
    console.error(
      `⚠️  JWT expires in ${Math.floor(secsLeft / 60)}min — may not finish the run`,
    );
  } else {
    console.error(`JWT valid for ${Math.floor(secsLeft / 60)}min`);
  }
}

const HEADERS = {
  "Authorization": `Bearer ${GLOFOX_DASHBOARD_JWT}`,
  "Content-Type": "application/json",
  "Accept": "application/json",
  "Origin": "https://app.glofox.com",
  "Referer": "https://app.glofox.com/dashboard/",
  "x-glofox-branch-id": STUDIO_ID,
  "x-glofox-branch-continent": "NA",
  "x-glofox-branch-timezone": "America/New_York",
  "x-glofox-source": "dashboard",
  "x-glofox-dashboard-page": "/discounts/definition",
  "x-glofox-dashboard-version": GLOFOX_DASHBOARD_VERSION,
};

// Pre-fetch existing promo codes so we can skip duplicates. Glofox enforces
// uniqueness on the `code` field (verified — collisions return an error
// during create), so attempting to re-upload would orphan a discount without
// a code attached. Pre-check makes the script safely idempotent — if the JWT
// expires mid-run or you find a bad code and want to fix the CSV and re-run,
// you won't get duplicates.
//
// The endpoint is paginated at 25/page via ?page=N (1-indexed). We walk
// pages until we get an empty response. Cap at 50 pages (= 1250 codes) for
// safety; if you ever exceed that, increase the cap or rethink the design.
async function fetchExistingPromoCodes(): Promise<Set<string>> {
  const set = new Set<string>();
  const PAGE_LIMIT = 50;
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const res = await fetch(
      `https://app.glofox.com/discount-api/v1/promo-codes?page=${page}`,
      { headers: HEADERS },
    );
    if (!res.ok) {
      throw new Error(
        `pre-fetch promo-codes page=${page} ${res.status}: ${await res.text()}`,
      );
    }
    const raw = await res.json();
    const arr = Array.isArray(raw) ? raw : raw?.promo_codes ?? raw?.data ?? [];
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const p of arr) {
      if (p && typeof p.code === "string") set.add(p.code);
    }
    if (arr.length < 25) break; // less than full page = last page
    if (page === PAGE_LIMIT) {
      console.error(
        `⚠️  pre-fetch hit ${PAGE_LIMIT}-page cap; some existing codes may not be in dedup set`,
      );
    }
  }
  return set;
}

async function createDiscount(code: string): Promise<string> {
  const url =
    `https://app.glofox.com/discount-api/v1/studios/${STUDIO_ID}/discounts`;
  const body = {
    name: DISCOUNT_NAME_PATTERN(code),
    description: DISCOUNT_DESCRIPTION,
    rate_value: DISCOUNT_RATE_VALUE,
    num_cycles: DISCOUNT_NUM_CYCLES,
    rate_type: DISCOUNT_RATE_TYPE,
    applies_to_joining_fee_only: DISCOUNT_APPLIES_TO_JOINING_FEE_ONLY,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`discounts ${res.status}: ${text.slice(0, 300)}`);
  }
  let json: { id?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`discounts response not JSON: ${text.slice(0, 200)}`);
  }
  if (!json.id) {
    throw new Error(`discounts response missing id: ${text.slice(0, 200)}`);
  }
  return json.id;
}

async function createPromoCode(
  discountId: string,
  code: string,
): Promise<string> {
  const url = "https://app.glofox.com/discount-api/v1/promo-codes";
  const body = {
    discount_id: discountId,
    code,
    code_enabled: true,
    usage_limit_per_user: PROMO_USAGE_LIMIT_PER_USER,
    max_usage_limit: PROMO_MAX_USAGE_LIMIT,
    assignments: PROMO_ASSIGNMENTS,
    utc_start_date: PROMO_UTC_START_DATE,
    utc_end_date: PROMO_UTC_END_DATE,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`promo-codes ${res.status}: ${text.slice(0, 300)}`);
  }
  let json: { id?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`promo-codes response not JSON: ${text.slice(0, 200)}`);
  }
  if (!json.id) {
    throw new Error(`promo-codes response missing id: ${text.slice(0, 200)}`);
  }
  return json.id;
}

// Best-effort: clean up an orphan discount if the promo-code POST fails.
// Without this, a half-failed code leaves a named discount in the dashboard
// with no code attached — visible noise. Best-effort because the JWT may
// also be the reason promo-code failed, in which case the DELETE will too.
async function deleteOrphanDiscount(discountId: string): Promise<void> {
  // Verified 2026-05-12: DELETE endpoint is studio-less; the studio-scoped
  // path returns 405. Best-effort: swallow all errors.
  try {
    await fetch(
      `https://app.glofox.com/discount-api/v1/discounts/${discountId}`,
      { method: "DELETE", headers: HEADERS },
    );
  } catch {
    // best-effort, swallow
  }
}

async function uploadOne(code: string): Promise<UploadResult> {
  const startedAt = Date.now();
  if (DRY_RUN) {
    return {
      code,
      ok: true,
      discount_id: "DRY_RUN",
      promo_code_id: "DRY_RUN",
      duration_ms: Date.now() - startedAt,
    };
  }
  let discountId: string | undefined;
  try {
    discountId = await createDiscount(code);
  } catch (err) {
    return {
      code,
      ok: false,
      error: `discount: ${err instanceof Error ? err.message : String(err)}`,
      duration_ms: Date.now() - startedAt,
    };
  }
  try {
    const promoCodeId = await createPromoCode(discountId, code);
    return {
      code,
      ok: true,
      discount_id: discountId,
      promo_code_id: promoCodeId,
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    // Promo-code POST failed — discount is orphaned, clean it up so the
    // dashboard isn't left with empty named discounts.
    await deleteOrphanDiscount(discountId);
    return {
      code,
      ok: false,
      discount_id: discountId,
      error: `promo-code: ${err instanceof Error ? err.message : String(err)} (orphan discount cleaned up)`,
      duration_ms: Date.now() - startedAt,
    };
  }
}

// --- Main ---

let codesRaw: string;
try {
  codesRaw = await Deno.readTextFile(CODES_FILE);
} catch (err) {
  bail(`could not read ${CODES_FILE}: ${err instanceof Error ? err.message : String(err)}`);
}

// Parse CSV or plain text:
//   - One code per line
//   - For .csv files, take only the first column (handles "CODE,extra,fields")
//   - Skip empty lines and lines starting with `#`
//   - Skip the first row if it looks like a header (no all-uppercase-alnum
//     content — Groupon codes are typically uppercase + digits)
function isLikelyCode(s: string): boolean {
  return /^[A-Z0-9_-]+$/.test(s) && s.length >= 4;
}

const allRows = codesRaw
  .split(/\r?\n/)
  .map((s) => s.split(",")[0].trim()) // CSV-safe: take first column
  .filter((s) => s.length > 0 && !s.startsWith("#"));

// Drop a header row if the first entry isn't code-shaped but the rest are
const codes = allRows.length > 1 && !isLikelyCode(allRows[0]) && isLikelyCode(allRows[1])
  ? allRows.slice(1)
  : allRows;

if (codes.length === 0) bail(`${CODES_FILE} is empty (no codes found)`);

// Idempotency: pre-fetch existing promo codes and skip duplicates.
// In dry-run we still pre-fetch so the planning summary is accurate.
let existing: Set<string>;
try {
  existing = await fetchExistingPromoCodes();
} catch (err) {
  bail(
    `failed to pre-fetch existing promo codes: ${err instanceof Error ? err.message : String(err)}\n` +
      `Make sure GLOFOX_DASHBOARD_JWT is current.`,
  );
}
console.error(`existing promo codes in Glofox: ${existing.size}`);

const newCodes = codes.filter((c) => !existing.has(c));
const skipped = codes.length - newCodes.length;
if (skipped > 0) {
  console.error(`skipping ${skipped} code(s) that already exist`);
}

const limited = Number.isFinite(LIMIT) ? newCodes.slice(0, LIMIT) : newCodes;

console.error(`
=== Glofox Bulk Discount Upload ===
codes file:        ${CODES_FILE}
codes in file:     ${codes.length}
already in Glofox: ${skipped} (will skip)
to upload:         ${limited.length}${DRY_RUN ? " (DRY RUN — no API calls)" : ""}
discount name:     ${DISCOUNT_NAME_PATTERN("EXAMPLE-CODE")}
discount type:     ${DISCOUNT_RATE_TYPE} ${DISCOUNT_RATE_VALUE / 1000}${DISCOUNT_RATE_TYPE === "percentage" ? "%" : " cents"}
num_cycles:        ${DISCOUNT_NUM_CYCLES}
promo single-use:  max_usage_limit=${PROMO_MAX_USAGE_LIMIT}, per_user=${PROMO_USAGE_LIMIT_PER_USER}
applies to:        ${JSON.stringify(PROMO_ASSIGNMENTS[0].include[0])}
pace:              ${PACE_MS}ms between codes (~${(1000 / PACE_MS).toFixed(1)}/sec)
ETA:               ~${Math.ceil((limited.length * PACE_MS * 2) / 1000 / 60)}min
results to:        ${RESULTS_FILE}
`);

const results: UploadResult[] = [];
for (let i = 0; i < limited.length; i++) {
  const code = limited[i];
  const r = await uploadOne(code);
  results.push(r);
  const tag = r.ok ? "✓" : "✗";
  console.log(
    `[${i + 1}/${limited.length}] ${tag} ${code}${r.error ? ` — ${r.error}` : ""}`,
  );
  // Abort fast if the JWT just expired — no point in burning the rest of
  // the codes against 401s.
  if (r.error?.includes("401")) {
    console.error("\nAuth failed — JWT likely expired. Stopping early.");
    break;
  }
  if (i < limited.length - 1 && !DRY_RUN) {
    await new Promise((resolve) => setTimeout(resolve, PACE_MS));
  }
}

// Audit log
await Deno.writeTextFile(
  RESULTS_FILE,
  JSON.stringify(
    {
      started_at: new Date().toISOString(),
      dry_run: DRY_RUN,
      total_codes: codes.length,
      attempted: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    },
    null,
    2,
  ),
);

const ok = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log(`\nDone: ${ok} ok / ${fail} failed (${RESULTS_FILE} for full audit)`);
