// Q9: filter which PushPress class types mirror to Glofox.
//
// CC's PushPress instance contains BOTH CrossFit and Sauna classes. We mirror
// only sauna activity into TSG's Glofox. The allowlist is the single source
// of truth for "is this a sauna class type?" — keyed on Class.classTypeName.
//
// Safety: an empty allowlist filters EVERYTHING. This is intentional — better
// to drop sauna events (visible ops gap) than to leak CF events into TSG's
// live production Glofox (data pollution that's hard to clean up).
//
// Configuration: comma-separated values in SAUNA_CLASS_TYPE_ALLOWLIST env var.
// Comparison is case-insensitive and trims surrounding whitespace.

let cached: readonly string[] | undefined;
let emptyWarned = false;

function load(): readonly string[] {
  if (cached === undefined) {
    const raw = Deno.env.get("SAUNA_CLASS_TYPE_ALLOWLIST") ?? "";
    cached = Object.freeze(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    );
  }
  return cached;
}

export function isSaunaClassType(classTypeName: string | null | undefined): boolean {
  const allowlist = load();

  if (allowlist.length === 0) {
    if (!emptyWarned) {
      emptyWarned = true;
      console.error(
        JSON.stringify({
          level: "warn",
          msg: "SAUNA_CLASS_TYPE_ALLOWLIST is empty — every reservation will be filtered",
        }),
      );
    }
    return false;
  }

  if (classTypeName == null) return false;
  return allowlist.includes(classTypeName.trim().toLowerCase());
}

export function getSaunaClassTypeAllowlist(): readonly string[] {
  return load();
}

// Test-only: drop the cached env so a Deno.env.set() before the next call
// takes effect. Not exported from a barrel — only tests should import it.
export function _resetForTests(): void {
  cached = undefined;
  emptyWarned = false;
}

// ---------------------------------------------------------------------------
// Plan-category filter (PR 2). Parallel to the class-type filter above but
// keyed on Plan.category.name (e.g. "Sauna" vs "Membership Plans"). Drives
// the enrollment.created handler's Q9 decision.
// ---------------------------------------------------------------------------

let cachedPlanCategory: readonly string[] | undefined;
let planCategoryEmptyWarned = false;

function loadPlanCategory(): readonly string[] {
  if (cachedPlanCategory === undefined) {
    const raw = Deno.env.get("SAUNA_PLAN_CATEGORY_ALLOWLIST") ?? "";
    cachedPlanCategory = Object.freeze(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    );
  }
  return cachedPlanCategory;
}

export function isSaunaPlanCategory(categoryName: string | null | undefined): boolean {
  const allowlist = loadPlanCategory();

  if (allowlist.length === 0) {
    if (!planCategoryEmptyWarned) {
      planCategoryEmptyWarned = true;
      console.error(
        JSON.stringify({
          level: "warn",
          msg: "SAUNA_PLAN_CATEGORY_ALLOWLIST is empty — every enrollment will be filtered",
        }),
      );
    }
    return false;
  }

  if (categoryName == null) return false;
  return allowlist.includes(categoryName.trim().toLowerCase());
}

export function getSaunaPlanCategoryAllowlist(): readonly string[] {
  return loadPlanCategory();
}

export function _resetPlanCategoryForTests(): void {
  cachedPlanCategory = undefined;
  planCategoryEmptyWarned = false;
}
