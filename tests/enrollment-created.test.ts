// deno-lint-ignore-file require-await
// (mock fns are async to match the real interfaces; bodies are synchronous)

// Integration tests for handleEnrollmentCreated.
//
// Mocks SupabaseClient, GlofoxClient (via the GlofoxClientShape interface),
// and PushPressClient at the dependency boundary. No fetch, no DB.
//
// Run with: deno test --allow-env --allow-read tests/enrollment-created.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleEnrollmentCreated } from "../supabase/functions/pushpress-webhook/handlers/enrollment-created.ts";
import { GlofoxApiError } from "../supabase/functions/_shared/glofox-client.ts";
import { _resetPlanCategoryForTests } from "../supabase/functions/_shared/filter.ts";
import type { PushPressWebhookBody } from "../supabase/functions/_shared/types.ts";

// --- Mock Supabase ---------------------------------------------------------

interface MockState {
  membersLink: Record<string, { glofox_user_id: string; email: string }>;
  planMappings: Record<
    string,
    {
      pushpress_plan_id: string;
      pushpress_plan_name: string;
      glofox_membership_id: string;
      glofox_plan_code: string;
      payment_method: string;
      glofox_promo_code: string | null;
      is_active: boolean;
    }
  >;
}

function newState(): MockState {
  return { membersLink: {}, planMappings: {} };
}

function mockSupabase(state: MockState) {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(col: string, value: string) {
              if (table === "plan_mappings" && col === "pushpress_plan_id") {
                // chained .eq("is_active", true).maybeSingle()
                return {
                  eq(_col2: string, activeValue: boolean) {
                    return {
                      async maybeSingle() {
                        const row = state.planMappings[value];
                        if (!row || row.is_active !== activeValue) {
                          return { data: null, error: null };
                        }
                        return { data: row, error: null };
                      },
                    };
                  },
                };
              }
              return {
                async maybeSingle() {
                  if (table === "members_link") {
                    const row = state.membersLink[value];
                    return {
                      data: row
                        ? {
                            pushpress_customer_id: value,
                            glofox_user_id: row.glofox_user_id,
                            email: row.email,
                          }
                        : null,
                      error: null,
                    };
                  }
                  return { data: null, error: null };
                },
              };
            },
          };
        },
        async insert(row: Record<string, unknown>) {
          if (table === "members_link") {
            const id = row.pushpress_customer_id as string;
            if (state.membersLink[id]) {
              return { error: { code: "23505", message: "dup" } };
            }
            state.membersLink[id] = {
              glofox_user_id: row.glofox_user_id as string,
              email: row.email as string,
            };
            return { error: null };
          }
          return { error: null };
        },
      };
    },
  };
}

// --- Mock external clients -------------------------------------------------

interface GlofoxStub {
  retrieveMemberByEmail?: (email: string) => Promise<{ _id: string } | null>;
  createLead?: () => Promise<{ _id: string }>;
  getEventsByTimeRange?: () => Promise<
    Array<{ _id: string; time_start: number; name?: string }>
  >;
  createBooking?: () => Promise<{ _id: string }>;
  purchaseMembership?: (args: {
    userId: string;
    membershipId: string;
    planCode: string;
    paymentMethod: string;
    promoCode?: string;
    startDate: string;
  }) => Promise<{ userMembershipId: string | null }>;
}

function mockGlofox(cfg: GlofoxStub = {}) {
  return {
    retrieveMemberByEmail: cfg.retrieveMemberByEmail ??
      (async () => ({ _id: "glofox-user-existing" })),
    createLead: cfg.createLead ?? (async () => ({ _id: "glofox-lead-new" })),
    getEventsByTimeRange: cfg.getEventsByTimeRange ?? (async () => []),
    createBooking: cfg.createBooking ?? (async () => ({ _id: "glofox-booking-x" })),
    purchaseMembership: cfg.purchaseMembership ??
      (async () => ({ userMembershipId: "glofox-userMembershipId-xyz" })),
  };
}

function mockPushPress(cfg: {
  getCustomer?: () => Promise<{
    id: string;
    email: string;
    name: { first: string; last: string };
    phone?: string | null;
  }>;
  getPlan?: () => Promise<{
    id: string;
    name: string;
    companyId: string;
    category: { name: string };
  }>;
} = {}) {
  return {
    getCustomer: cfg.getCustomer ??
      (async () => ({
        id: "pp-customer-1",
        email: "test@example.com",
        name: { first: "Test", last: "User" },
        phone: null,
      })),
    getClass: async () => ({
      id: "cls",
      classTypeName: "Sauna",
      start: 0,
      end: 0,
    }),
    getPlan: cfg.getPlan ??
      (async () => ({
        id: "plan-test",
        name: "Sauna 8 Pack (Recurring)",
        companyId: "client_test",
        category: { name: "Sauna" },
      })),
  };
}

// --- Fixtures --------------------------------------------------------------

const DEFAULT_PLAN_ID = "plan_1b27d4595fa44a";
const DEFAULT_CUSTOMER_ID = "usr_788d5a14a582ad1386e14303a970ca52";

function enrollmentBody(
  overrides: {
    id?: string;
    customerId?: string;
    planId?: string;
    startDate?: string | null;
  } = {},
): PushPressWebhookBody {
  return {
    event: "enrollment.created",
    created: 1715443200,
    data: {
      id: overrides.id ?? `sub_test_${Math.floor(Math.random() * 1e10)}`,
      customerId: overrides.customerId === undefined ? DEFAULT_CUSTOMER_ID : overrides.customerId,
      planId: overrides.planId === undefined ? DEFAULT_PLAN_ID : overrides.planId,
      companyId: "client_test",
      status: "active",
      startDate: overrides.startDate ?? "2026-05-11T00:00:00-04:00",
      billingSchedule: { period: "month", interval: 1 },
    },
  };
}

function seedDefaultPlanMapping(state: MockState): void {
  state.planMappings[DEFAULT_PLAN_ID] = {
    pushpress_plan_id: DEFAULT_PLAN_ID,
    pushpress_plan_name: "Sauna 8 Pack (Recurring)",
    glofox_membership_id: "69fe0e2c238a9b2cd206fa15",
    glofox_plan_code: "1778259589341",
    payment_method: "cash",
    glofox_promo_code: "TESTCODE",
    is_active: true,
  };
}

function withSaunaPlanCategory(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const prev = Deno.env.get("SAUNA_PLAN_CATEGORY_ALLOWLIST");
    Deno.env.set("SAUNA_PLAN_CATEGORY_ALLOWLIST", "Sauna");
    _resetPlanCategoryForTests();
    try {
      await fn();
    } finally {
      if (prev === undefined) Deno.env.delete("SAUNA_PLAN_CATEGORY_ALLOWLIST");
      else Deno.env.set("SAUNA_PLAN_CATEGORY_ALLOWLIST", prev);
      _resetPlanCategoryForTests();
    }
  };
}

// --- Tests -----------------------------------------------------------------

Deno.test(
  "1. happy path: sauna enrollment → purchaseMembership called → success",
  withSaunaPlanCategory(async () => {
    const state = newState();
    seedDefaultPlanMapping(state);
    let purchaseCalled = false;
    let purchaseArgs: { promoCode?: string; paymentMethod?: string } = {};
    const glofox = mockGlofox({
      purchaseMembership: async (args) => {
        purchaseCalled = true;
        purchaseArgs = args;
        return { userMembershipId: "real-glofox-ums-id" };
      },
    });

    const result = await handleEnrollmentCreated(enrollmentBody(), {
      // deno-lint-ignore no-explicit-any
      supabase: mockSupabase(state) as any,
      // deno-lint-ignore no-explicit-any
      glofox: glofox as any,
      // deno-lint-ignore no-explicit-any
      pushpress: mockPushPress() as any,
    });

    assertEquals(result.status, "success");
    assertEquals(
      (result.glofoxResponse as { userMembershipId: string }).userMembershipId,
      "real-glofox-ums-id",
    );
    assertEquals(purchaseCalled, true);
    assertEquals(purchaseArgs.promoCode, "TESTCODE");
    assertEquals(purchaseArgs.paymentMethod, "cash");
  }),
);

Deno.test(
  "2. non-sauna plan (category=Membership Plans) → filtered, no Glofox writes",
  withSaunaPlanCategory(async () => {
    const state = newState();
    seedDefaultPlanMapping(state);
    let purchaseCalled = false;
    const glofox = mockGlofox({
      purchaseMembership: async () => {
        purchaseCalled = true;
        return { userMembershipId: "should-not-be-called" };
      },
    });
    const pushpress = mockPushPress({
      getPlan: async () => ({
        id: "plan-cf",
        name: "Unlimited (6 Month)",
        companyId: "client_test",
        category: { name: "Membership Plans" },
      }),
    });

    const result = await handleEnrollmentCreated(enrollmentBody(), {
      // deno-lint-ignore no-explicit-any
      supabase: mockSupabase(state) as any,
      // deno-lint-ignore no-explicit-any
      glofox: glofox as any,
      // deno-lint-ignore no-explicit-any
      pushpress: pushpress as any,
    });

    assertEquals(result.status, "filtered");
    assertEquals(purchaseCalled, false);
  }),
);

Deno.test(
  "3. unmapped plan (no plan_mappings row) → failed, error includes 'unmapped_plan'",
  withSaunaPlanCategory(async () => {
    const state = newState();
    // No plan_mappings seed.
    let purchaseCalled = false;
    const glofox = mockGlofox({
      purchaseMembership: async () => {
        purchaseCalled = true;
        return { userMembershipId: "should-not-be-called" };
      },
    });

    const result = await handleEnrollmentCreated(
      enrollmentBody({ planId: "plan_does_not_exist" }),
      {
        // deno-lint-ignore no-explicit-any
        supabase: mockSupabase(state) as any,
        // deno-lint-ignore no-explicit-any
        glofox: glofox as any,
        // deno-lint-ignore no-explicit-any
        pushpress: mockPushPress() as any,
      },
    );

    assertEquals(result.status, "failed");
    assertEquals(result.error?.startsWith("unmapped_plan"), true);
    assertEquals(purchaseCalled, false);
  }),
);

Deno.test(
  "4. member unlinkable: pushpress.getCustomer throws → failed (member_unlinkable)",
  withSaunaPlanCategory(async () => {
    const state = newState();
    seedDefaultPlanMapping(state);
    const pushpress = mockPushPress({
      getCustomer: async () => {
        throw new Error("PushPress 404: customer not found");
      },
    });

    const result = await handleEnrollmentCreated(enrollmentBody(), {
      // deno-lint-ignore no-explicit-any
      supabase: mockSupabase(state) as any,
      // deno-lint-ignore no-explicit-any
      glofox: mockGlofox() as any,
      // deno-lint-ignore no-explicit-any
      pushpress: pushpress as any,
    });

    assertEquals(result.status, "failed");
    assertEquals(result.error?.startsWith("member_unlinkable"), true);
  }),
);

Deno.test(
  "5. Glofox purchase throws GlofoxApiError → failed (error captured)",
  withSaunaPlanCategory(async () => {
    const state = newState();
    seedDefaultPlanMapping(state);
    const glofox = mockGlofox({
      purchaseMembership: async () => {
        throw new GlofoxApiError(400, "/2.2/.../purchase", "invalid payment_method");
      },
    });

    const result = await handleEnrollmentCreated(enrollmentBody(), {
      // deno-lint-ignore no-explicit-any
      supabase: mockSupabase(state) as any,
      // deno-lint-ignore no-explicit-any
      glofox: glofox as any,
      // deno-lint-ignore no-explicit-any
      pushpress: mockPushPress() as any,
    });

    assertEquals(result.status, "failed");
    assertEquals(
      (result.glofoxResponse as { status: number }).status,
      400,
    );
  }),
);

Deno.test(
  "6. Glofox returns null userMembershipId → still success (DQ7 — defensive)",
  withSaunaPlanCategory(async () => {
    const state = newState();
    seedDefaultPlanMapping(state);
    const glofox = mockGlofox({
      purchaseMembership: async () => ({ userMembershipId: null }),
    });

    const result = await handleEnrollmentCreated(enrollmentBody(), {
      // deno-lint-ignore no-explicit-any
      supabase: mockSupabase(state) as any,
      // deno-lint-ignore no-explicit-any
      glofox: glofox as any,
      // deno-lint-ignore no-explicit-any
      pushpress: mockPushPress() as any,
    });

    assertEquals(result.status, "success");
    assertEquals(
      (result.glofoxResponse as { userMembershipId: string | null }).userMembershipId,
      null,
    );
  }),
);

Deno.test(
  "7. missing planId → failed (error='missing_planId')",
  withSaunaPlanCategory(async () => {
    const state = newState();
    seedDefaultPlanMapping(state);

    const bodyNoPlanId: PushPressWebhookBody = {
      event: "enrollment.created",
      created: 1715443200,
      data: {
        id: "sub_no_plan",
        customerId: DEFAULT_CUSTOMER_ID,
        companyId: "client_test",
        status: "active",
      },
    };

    const result = await handleEnrollmentCreated(bodyNoPlanId, {
      // deno-lint-ignore no-explicit-any
      supabase: mockSupabase(state) as any,
      // deno-lint-ignore no-explicit-any
      glofox: mockGlofox() as any,
      // deno-lint-ignore no-explicit-any
      pushpress: mockPushPress() as any,
    });

    assertEquals(result.status, "failed");
    assertEquals(result.error, "missing_planId");
  }),
);

Deno.test(
  "8. missing customerId → failed",
  withSaunaPlanCategory(async () => {
    const state = newState();
    seedDefaultPlanMapping(state);

    const bodyNoCustomer: PushPressWebhookBody = {
      event: "enrollment.created",
      created: 1715443200,
      data: {
        id: "sub_no_customer",
        planId: DEFAULT_PLAN_ID,
        companyId: "client_test",
        status: "active",
      },
    };

    const result = await handleEnrollmentCreated(bodyNoCustomer, {
      // deno-lint-ignore no-explicit-any
      supabase: mockSupabase(state) as any,
      // deno-lint-ignore no-explicit-any
      glofox: mockGlofox() as any,
      // deno-lint-ignore no-explicit-any
      pushpress: mockPushPress() as any,
    });

    assertEquals(result.status, "failed");
  }),
);
