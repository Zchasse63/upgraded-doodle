// deno-lint-ignore-file require-await
// (mock functions are async to match the real GlofoxClient / PushPressClient
// interface signatures; their bodies are synchronous by design)

// Integration tests for handleReservationCreated.
//
// Mocks SupabaseClient, GlofoxClient, and PushPressClient at the dependency
// boundary. No fetch is made; no DB is hit. This verifies the handler's
// orchestration logic (cache lookup, filter, member resolution, slot
// resolution, booking, pending_refunds enqueue).
//
// The dispatcher (index.ts), DB inserts, and end-to-end signed-payload curl
// are verified manually via `supabase functions serve` — see docs/pr-1-plan.md
// acceptance criteria.
//
// Run with: deno test --allow-env tests/integration.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleReservationCreated } from "../supabase/functions/pushpress-webhook/handlers/reservation-created.ts";
import {
  GlofoxCapacityError,
  type GlofoxEvent,
} from "../supabase/functions/_shared/glofox-client.ts";
import { _resetForTests as resetFilter } from "../supabase/functions/_shared/filter.ts";
import type { PushPressWebhookBody } from "../supabase/functions/_shared/types.ts";

// --- Mock state -------------------------------------------------------------

interface MockState {
  membersLink: Record<string, { glofox_user_id: string; email: string }>;
  slotMappings: Record<
    string,
    { glofox_event_id: string; class_type: string | null }
  >;
  pendingRefunds: Array<{
    pushpress_reservation_id: string;
    failure_reason: string;
    glofox_error: string | null;
  }>;
}

function newState(): MockState {
  return { membersLink: {}, slotMappings: {}, pendingRefunds: [] };
}

// --- Mock Supabase ----------------------------------------------------------

function mockSupabase(state: MockState): {
  client: ReturnType<typeof makeSupabaseClient>;
  state: MockState;
} {
  return { client: makeSupabaseClient(state), state };
}

function makeSupabaseClient(state: MockState) {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, value: string) {
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
                  if (table === "slot_mappings") {
                    const row = state.slotMappings[value];
                    return {
                      data: row
                        ? {
                            pushpress_calendar_item_id: value,
                            glofox_event_id: row.glofox_event_id,
                            class_type: row.class_type,
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
          if (table === "slot_mappings") {
            const id = row.pushpress_calendar_item_id as string;
            if (state.slotMappings[id]) {
              return { error: { code: "23505", message: "dup" } };
            }
            state.slotMappings[id] = {
              glofox_event_id: row.glofox_event_id as string,
              class_type: (row.class_type as string | null) ?? null,
            };
            return { error: null };
          }
          if (table === "pending_refunds") {
            const id = row.pushpress_reservation_id as string;
            if (state.pendingRefunds.some((r) => r.pushpress_reservation_id === id)) {
              return { error: { code: "23505", message: "dup" } };
            }
            state.pendingRefunds.push({
              pushpress_reservation_id: id,
              failure_reason: row.failure_reason as string,
              glofox_error: (row.glofox_error as string | null) ?? null,
            });
            return { error: null };
          }
          return { error: null };
        },
      };
    },
  };
}

// --- Mock Glofox ------------------------------------------------------------

interface GlofoxMockConfig {
  retrieveMemberByEmail?: (email: string) => Promise<{ _id: string } | null>;
  createLead?: () => Promise<{ _id: string }>;
  getEventsByTimeRange?: () => Promise<GlofoxEvent[]>;
  createBooking?: () => Promise<{ _id: string }>;
}

function mockGlofox(cfg: GlofoxMockConfig = {}) {
  return {
    retrieveMemberByEmail:
      cfg.retrieveMemberByEmail ?? (async () => ({ _id: "glofox-user-default" })),
    createLead: cfg.createLead ?? (async () => ({ _id: "glofox-lead-default" })),
    getEventsByTimeRange:
      cfg.getEventsByTimeRange ??
      (async () => [
        { _id: "glofox-event-default", time_start: 1715443200, name: "Sauna - 50min" },
      ]),
    createBooking: cfg.createBooking ?? (async () => ({ _id: "glofox-booking-default" })),
  };
}

// --- Mock PushPress ---------------------------------------------------------

interface PushPressMockConfig {
  getCustomer?: () => Promise<{
    id: string;
    email: string;
    name: { first: string; last: string };
    phone?: string | null;
  }>;
  getClass?: () => Promise<{
    id: string;
    classTypeName?: string | null;
    start: number;
    end: number;
  }>;
}

function mockPushPress(cfg: PushPressMockConfig = {}) {
  return {
    getCustomer:
      cfg.getCustomer ??
      (async () => ({
        id: "pp-customer-default",
        email: "test@example.com",
        name: { first: "Test", last: "User" },
        phone: null,
      })),
    getClass:
      cfg.getClass ??
      (async () => ({
        id: "pp-class-default",
        classTypeName: "Sauna - 50min",
        start: 1715443200,
        end: 1715446200,
      })),
  };
}

// --- Fixtures ---------------------------------------------------------------

function reservationBody(
  overrides: Partial<{
    id: string;
    reservedId: string;
    customerId: string;
    companyId: string;
  }> = {},
): PushPressWebhookBody {
  return {
    event: "reservation.created",
    created: 1715443200,
    data: {
      id: overrides.id ?? "pp-reservation-1",
      reservedId: overrides.reservedId ?? "pp-class-1",
      customerId: overrides.customerId ?? "pp-customer-1",
      companyId: overrides.companyId ?? "pp-company-1",
      registrationTimestamp: 1715443100,
      status: "reserved",
    },
  };
}

function withSaunaAllowlist(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const prev = Deno.env.get("SAUNA_CLASS_TYPE_ALLOWLIST");
    Deno.env.set("SAUNA_CLASS_TYPE_ALLOWLIST", "Sauna - 50min,Cold Plunge");
    resetFilter();
    try {
      await fn();
    } finally {
      if (prev === undefined) Deno.env.delete("SAUNA_CLASS_TYPE_ALLOWLIST");
      else Deno.env.set("SAUNA_CLASS_TYPE_ALLOWLIST", prev);
      resetFilter();
    }
  };
}

// --- Tests ------------------------------------------------------------------

Deno.test(
  "happy path: sauna reservation → Glofox booking created + slot_mapping cached",
  withSaunaAllowlist(async () => {
    const { client: supabase, state } = mockSupabase(newState());
    const glofox = mockGlofox();
    const pushpress = mockPushPress();

    const result = await handleReservationCreated(reservationBody(), {
      // deno-lint-ignore no-explicit-any
      supabase: supabase as any,
      // deno-lint-ignore no-explicit-any
      glofox: glofox as any,
      // deno-lint-ignore no-explicit-any
      pushpress: pushpress as any,
    });

    assertEquals(result.status, "success");
    assertEquals(
      (result.glofoxResponse as { bookingId: string }).bookingId,
      "glofox-booking-default",
    );
    assertEquals(state.membersLink["pp-customer-1"].glofox_user_id, "glofox-user-default");
    assertEquals(state.slotMappings["pp-class-1"].glofox_event_id, "glofox-event-default");
    assertEquals(state.pendingRefunds.length, 0);
  }),
);

Deno.test(
  "filter: CrossFit class type → status='filtered', no Glofox calls, no DB writes",
  withSaunaAllowlist(async () => {
    const { client: supabase, state } = mockSupabase(newState());
    let createBookingCalled = false;
    const glofox = mockGlofox({
      createBooking: async () => {
        createBookingCalled = true;
        return { _id: "should-not-be-called" };
      },
    });
    const pushpress = mockPushPress({
      getClass: async () => ({
        id: "pp-class-cf-1",
        classTypeName: "CrossFit WOD",
        start: 1715443200,
        end: 1715446200,
      }),
    });

    const result = await handleReservationCreated(reservationBody(), {
      // deno-lint-ignore no-explicit-any
      supabase: supabase as any,
      // deno-lint-ignore no-explicit-any
      glofox: glofox as any,
      // deno-lint-ignore no-explicit-any
      pushpress: pushpress as any,
    });

    assertEquals(result.status, "filtered");
    assertEquals(createBookingCalled, false);
    assertEquals(state.membersLink["pp-customer-1"], undefined);
    assertEquals(state.slotMappings["pp-class-1"], undefined);
    assertEquals(state.pendingRefunds.length, 0);
  }),
);

Deno.test(
  "capacity error: Glofox returns capacity-full → pending_refunds enqueued",
  withSaunaAllowlist(async () => {
    const { client: supabase, state } = mockSupabase(newState());
    const glofox = mockGlofox({
      createBooking: async () => {
        throw new GlofoxCapacityError(409, "/2.3/.../bookings", "class is full");
      },
    });
    const pushpress = mockPushPress();

    const result = await handleReservationCreated(
      reservationBody({ id: "pp-reservation-cap-1" }),
      {
        // deno-lint-ignore no-explicit-any
        supabase: supabase as any,
        // deno-lint-ignore no-explicit-any
        glofox: glofox as any,
        // deno-lint-ignore no-explicit-any
        pushpress: pushpress as any,
      },
    );

    assertEquals(result.status, "failed");
    assertEquals(result.error, "capacity_full");
    assertEquals(state.pendingRefunds.length, 1);
    assertEquals(state.pendingRefunds[0].failure_reason, "capacity_full");
    assertEquals(
      state.pendingRefunds[0].pushpress_reservation_id,
      "pp-reservation-cap-1",
    );
  }),
);

Deno.test(
  "slot unmappable: no matching Glofox event → pending_refunds (slot_unmappable)",
  withSaunaAllowlist(async () => {
    const { client: supabase, state } = mockSupabase(newState());
    const glofox = mockGlofox({
      getEventsByTimeRange: async () => [], // no matching event
    });
    const pushpress = mockPushPress();

    const result = await handleReservationCreated(
      reservationBody({ id: "pp-reservation-slot-1" }),
      {
        // deno-lint-ignore no-explicit-any
        supabase: supabase as any,
        // deno-lint-ignore no-explicit-any
        glofox: glofox as any,
        // deno-lint-ignore no-explicit-any
        pushpress: pushpress as any,
      },
    );

    assertEquals(result.status, "failed");
    assertEquals(result.error, "slot_unmappable");
    assertEquals(state.pendingRefunds.length, 1);
    assertEquals(state.pendingRefunds[0].failure_reason, "slot_unmappable");
  }),
);

Deno.test(
  "member unlinkable: PushPress getCustomer throws → pending_refunds (member_unlinkable)",
  withSaunaAllowlist(async () => {
    const { client: supabase, state } = mockSupabase(newState());
    const glofox = mockGlofox();
    const pushpress = mockPushPress({
      getCustomer: async () => {
        throw new Error("PushPress 404: customer not found");
      },
    });

    const result = await handleReservationCreated(
      reservationBody({ id: "pp-reservation-mem-1" }),
      {
        // deno-lint-ignore no-explicit-any
        supabase: supabase as any,
        // deno-lint-ignore no-explicit-any
        glofox: glofox as any,
        // deno-lint-ignore no-explicit-any
        pushpress: pushpress as any,
      },
    );

    assertEquals(result.status, "failed");
    assertEquals(result.error?.startsWith("member_unlinkable"), true);
    assertEquals(state.pendingRefunds.length, 1);
    assertEquals(state.pendingRefunds[0].failure_reason, "member_unlinkable");
  }),
);

Deno.test(
  "missing customerId: returns failed without calling external services",
  withSaunaAllowlist(async () => {
    const { client: supabase, state } = mockSupabase(newState());
    let glofoxCalled = false;
    let pushpressCalled = false;
    const glofox = mockGlofox({
      retrieveMemberByEmail: async () => {
        glofoxCalled = true;
        return null;
      },
    });
    const pushpress = mockPushPress({
      getCustomer: async () => {
        pushpressCalled = true;
        throw new Error("should not be called");
      },
    });

    const body: PushPressWebhookBody = {
      event: "reservation.created",
      created: 1715443200,
      data: { id: "pp-r-x", reservedId: "pp-c-x", registrationTimestamp: 1 },
    };
    const result = await handleReservationCreated(body, {
      // deno-lint-ignore no-explicit-any
      supabase: supabase as any,
      // deno-lint-ignore no-explicit-any
      glofox: glofox as any,
      // deno-lint-ignore no-explicit-any
      pushpress: pushpress as any,
    });

    assertEquals(result.status, "failed");
    assertEquals(glofoxCalled, false);
    assertEquals(pushpressCalled, false);
    assertEquals(state.pendingRefunds.length, 0);
  }),
);

Deno.test(
  "member-link cache hit: reuses existing link, skips PushPress + Glofox member lookups",
  withSaunaAllowlist(async () => {
    const state = newState();
    state.membersLink["pp-customer-cached"] = {
      glofox_user_id: "glofox-user-cached",
      email: "cached@example.com",
    };
    const { client: supabase } = { client: makeSupabaseClient(state) };

    let pushpressGetCustomerCalled = false;
    let glofoxRetrieveCalled = false;
    const glofox = mockGlofox({
      retrieveMemberByEmail: async () => {
        glofoxRetrieveCalled = true;
        return null;
      },
    });
    const pushpress = mockPushPress({
      getCustomer: async () => {
        pushpressGetCustomerCalled = true;
        throw new Error("should not call");
      },
    });

    const result = await handleReservationCreated(
      reservationBody({ customerId: "pp-customer-cached" }),
      {
        // deno-lint-ignore no-explicit-any
        supabase: supabase as any,
        // deno-lint-ignore no-explicit-any
        glofox: glofox as any,
        // deno-lint-ignore no-explicit-any
        pushpress: pushpress as any,
      },
    );

    assertEquals(result.status, "success");
    assertEquals(pushpressGetCustomerCalled, false);
    assertEquals(glofoxRetrieveCalled, false);
  }),
);
