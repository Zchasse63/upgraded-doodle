// Unit tests for the Q9 sauna class-type filter.
// Run with: deno test --allow-env tests/filter.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetForTests,
  _resetPlanCategoryForTests,
  getSaunaClassTypeAllowlist,
  getSaunaPlanCategoryAllowlist,
  isSaunaClassType,
  isSaunaPlanCategory,
} from "../supabase/functions/_shared/filter.ts";

function withAllowlist(value: string, fn: () => void): void {
  const prev = Deno.env.get("SAUNA_CLASS_TYPE_ALLOWLIST");
  Deno.env.set("SAUNA_CLASS_TYPE_ALLOWLIST", value);
  _resetForTests();
  try {
    fn();
  } finally {
    if (prev === undefined) Deno.env.delete("SAUNA_CLASS_TYPE_ALLOWLIST");
    else Deno.env.set("SAUNA_CLASS_TYPE_ALLOWLIST", prev);
    _resetForTests();
  }
}

Deno.test("isSaunaClassType: known sauna type → true", () => {
  withAllowlist("Sauna - 50min,Cold Plunge,Contrast Therapy", () => {
    assertEquals(isSaunaClassType("Sauna - 50min"), true);
    assertEquals(isSaunaClassType("Cold Plunge"), true);
    assertEquals(isSaunaClassType("Contrast Therapy"), true);
  });
});

Deno.test("isSaunaClassType: CF class type → false", () => {
  withAllowlist("Sauna - 50min,Cold Plunge", () => {
    assertEquals(isSaunaClassType("CrossFit"), false);
    assertEquals(isSaunaClassType("Open Gym"), false);
    assertEquals(isSaunaClassType("Olympic Lifting"), false);
  });
});

Deno.test("isSaunaClassType: null and undefined → false", () => {
  withAllowlist("Sauna - 50min", () => {
    assertEquals(isSaunaClassType(null), false);
    assertEquals(isSaunaClassType(undefined), false);
  });
});

Deno.test("isSaunaClassType: case-insensitive", () => {
  withAllowlist("Sauna - 50min,Cold Plunge", () => {
    assertEquals(isSaunaClassType("sauna - 50min"), true);
    assertEquals(isSaunaClassType("SAUNA - 50MIN"), true);
    assertEquals(isSaunaClassType("CoLd PlUnGe"), true);
  });
});

Deno.test("isSaunaClassType: whitespace tolerated on both env and input", () => {
  withAllowlist("  Sauna - 50min  ,Cold Plunge  ", () => {
    assertEquals(isSaunaClassType("Sauna - 50min"), true);
    assertEquals(isSaunaClassType("  Sauna - 50min  "), true);
    assertEquals(isSaunaClassType("Cold Plunge"), true);
  });
});

Deno.test("isSaunaClassType: empty allowlist → false for everything (safe default)", () => {
  withAllowlist("", () => {
    assertEquals(isSaunaClassType("Sauna - 50min"), false);
    assertEquals(isSaunaClassType("CrossFit"), false);
    assertEquals(isSaunaClassType("anything"), false);
  });
});

Deno.test("isSaunaClassType: allowlist with only whitespace entries → empty allowlist", () => {
  withAllowlist(" , , ", () => {
    assertEquals(getSaunaClassTypeAllowlist().length, 0);
    assertEquals(isSaunaClassType("Sauna - 50min"), false);
  });
});

Deno.test("getSaunaClassTypeAllowlist: returns parsed, lowercased values", () => {
  withAllowlist("Sauna - 50min,Cold Plunge", () => {
    const list = getSaunaClassTypeAllowlist();
    assertEquals(list, ["sauna - 50min", "cold plunge"]);
  });
});

Deno.test("getSaunaClassTypeAllowlist: empty env returns empty array", () => {
  withAllowlist("", () => {
    assertEquals(getSaunaClassTypeAllowlist(), []);
  });
});

// --- Plan-category filter (PR 2) -------------------------------------------

function withPlanCategoryAllowlist(value: string, fn: () => void): void {
  const prev = Deno.env.get("SAUNA_PLAN_CATEGORY_ALLOWLIST");
  Deno.env.set("SAUNA_PLAN_CATEGORY_ALLOWLIST", value);
  _resetPlanCategoryForTests();
  try {
    fn();
  } finally {
    if (prev === undefined) Deno.env.delete("SAUNA_PLAN_CATEGORY_ALLOWLIST");
    else Deno.env.set("SAUNA_PLAN_CATEGORY_ALLOWLIST", prev);
    _resetPlanCategoryForTests();
  }
}

Deno.test("isSaunaPlanCategory: 'Sauna' in allowlist → true", () => {
  withPlanCategoryAllowlist("Sauna", () => {
    assertEquals(isSaunaPlanCategory("Sauna"), true);
  });
});

Deno.test("isSaunaPlanCategory: CF-side category → false", () => {
  withPlanCategoryAllowlist("Sauna", () => {
    assertEquals(isSaunaPlanCategory("Membership Plans"), false);
    assertEquals(isSaunaPlanCategory("Specialty"), false);
  });
});

Deno.test("isSaunaPlanCategory: null/undefined → false", () => {
  withPlanCategoryAllowlist("Sauna", () => {
    assertEquals(isSaunaPlanCategory(null), false);
    assertEquals(isSaunaPlanCategory(undefined), false);
  });
});

Deno.test("isSaunaPlanCategory: case-insensitive", () => {
  withPlanCategoryAllowlist("Sauna", () => {
    assertEquals(isSaunaPlanCategory("SAUNA"), true);
    assertEquals(isSaunaPlanCategory("sauna"), true);
    assertEquals(isSaunaPlanCategory("SaUnA"), true);
  });
});

Deno.test("isSaunaPlanCategory: whitespace tolerated on env and input", () => {
  withPlanCategoryAllowlist("  Sauna  ", () => {
    assertEquals(isSaunaPlanCategory("  Sauna  "), true);
    assertEquals(isSaunaPlanCategory("Sauna"), true);
  });
});

Deno.test("isSaunaPlanCategory: empty allowlist → false (safe default)", () => {
  withPlanCategoryAllowlist("", () => {
    assertEquals(isSaunaPlanCategory("Sauna"), false);
    assertEquals(isSaunaPlanCategory("anything"), false);
  });
});

Deno.test("getSaunaPlanCategoryAllowlist: empty env returns empty array", () => {
  withPlanCategoryAllowlist("", () => {
    assertEquals(getSaunaPlanCategoryAllowlist(), []);
  });
});
