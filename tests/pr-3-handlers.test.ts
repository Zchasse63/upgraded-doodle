// deno-lint-ignore-file require-await
// PR 3 handler tests — covers the new 7 handlers.
//
// Each handler is tested for its primary branches: happy path, the most
// important failure mode, and the most important filter/skip mode. The mocks
// are deliberately minimal — they implement just enough of the Supabase
// query builder + GlofoxClientShape to satisfy each handler's dependencies.
//
// Run with: deno test --allow-env --allow-read tests/pr-3-handlers.test.ts

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { handleReservationCanceled } from "../supabase/functions/pushpress-webhook/handlers/reservation-canceled.ts";
import { handleClassCanceled } from "../supabase/functions/pushpress-webhook/handlers/class-canceled.ts";
import { handleEnrollmentStatusChanged } from "../supabase/functions/pushpress-webhook/handlers/enrollment-status-changed.ts";
import { handleEnrollmentDeleted } from "../supabase/functions/pushpress-webhook/handlers/enrollment-deleted.ts";
import { handleCheckinCreated } from "../supabase/functions/pushpress-webhook/handlers/checkin-created.ts";
import { handleCustomerDetailsChanged } from "../supabase/functions/pushpress-webhook/handlers/customer-details-changed.ts";
import { handleReservationWaitlisted } from "../supabase/functions/pushpress-webhook/handlers/reservation-waitlisted.ts";

import { GlofoxApiError, GlofoxMockClient } from "../supabase/functions/_shared/glofox-client.ts";
import { _resetForTests } from "../supabase/functions/_shared/filter.ts";
import type {
  GlofoxClientShape,
  GlofoxMembershipSummary,
} from "../supabase/functions/_shared/types.ts";

// --- Shared mock supabase --------------------------------------------------

interface MockTables {
  event_log: Array<Record<string, unknown>>;
  members_link: Record<string, { glofox_user_id: string; email: string }>;
  slot_mappings: Record<string, { glofox_event_id: string; class_type: string | null }>;
  plan_mappings: Record<
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
  pushpress_enrollment_links: Record<
    string,
    {
      pushpress_enrollment_id: string;
      pushpress_customer_id: string;
      glofox_user_membership_id: string | null;
      linked_via: string;
    }
  >;
  pending_refunds: Array<Record<string, unknown>>;
}

function newTables(): MockTables {
  return {
    event_log: [],
    members_link: {},
    slot_mappings: {},
    plan_mappings: {},
    pushpress_enrollment_links: {},
    pending_refunds: [],
  };
}

// Minimal query builder mock — supports the patterns used by PR 3 handlers.
// Each method chain ends in maybeSingle, single, or (the count) `head:true`.
function mockSupabase(tables: MockTables) {
  return {
    from(table: keyof MockTables) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const builder = {
        select(_cols?: string, _opts?: { count?: string; head?: boolean }) {
          return builder;
        },
        eq(col: string, value: unknown) {
          filters.push((row) => row[col] === value);
          return builder;
        },
        filter(col: string, op: string, value: unknown) {
          if (op !== "eq") throw new Error(`mock: unsupported filter op ${op}`);
          filters.push((row) => {
            const payload = row.payload as { data?: Record<string, unknown> } | undefined;
            if (col === "payload->data->>id") return payload?.data?.id === value;
            if (col === "payload->data->>reservedId") return payload?.data?.reservedId === value;
            if (col === "payload->data->>customerId") return payload?.data?.customerId === value;
            throw new Error(`mock: unsupported filter column ${col}`);
          });
          return builder;
        },
        gte(_col: string, _value: unknown) {
          return builder;
        },
        order(_col: string, _opts?: { ascending?: boolean }) {
          return builder;
        },
        limit(_n: number) {
          return builder;
        },
        async maybeSingle() {
          const row = findFirst(table, tables, filters);
          return { data: row, error: null };
        },
        // .then for "exec" cases (some Supabase chains end without maybeSingle —
        // e.g. when used like `await supabase.from(t).select().eq(...)`)
        then(resolve: (v: { data: unknown[]; error: null; count?: number }) => void) {
          const rows = findAll(table, tables, filters);
          resolve({ data: rows, error: null, count: rows.length });
        },
      };
      return {
        ...builder,
        async insert(row: Record<string, unknown>) {
          if (table === "pushpress_enrollment_links") {
            const id = row.pushpress_enrollment_id as string;
            if (tables.pushpress_enrollment_links[id]) {
              return { error: { code: "23505", message: "dup" } };
            }
            tables.pushpress_enrollment_links[id] = {
              pushpress_enrollment_id: id,
              pushpress_customer_id: row.pushpress_customer_id as string,
              glofox_user_membership_id: row.glofox_user_membership_id as string | null,
              linked_via: row.linked_via as string,
            };
          }
          if (table === "pending_refunds") {
            tables.pending_refunds.push(row);
          }
          if (table === "event_log") {
            tables.event_log.push(row);
          }
          return { error: null };
        },
        update(updates: Record<string, unknown>) {
          return {
            eq(col: string, value: unknown) {
              return new Promise<{ error: null }>((resolve) => {
                if (table === "pushpress_enrollment_links" && col === "pushpress_enrollment_id") {
                  const row = tables.pushpress_enrollment_links[value as string];
                  if (row) Object.assign(row, updates);
                }
                resolve({ error: null });
              });
            },
          };
        },
      };
    },
  };
}

function findFirst(
  table: keyof MockTables,
  tables: MockTables,
  filters: Array<(row: Record<string, unknown>) => boolean>,
): Record<string, unknown> | null {
  for (const row of findAll(table, tables, filters)) return row;
  return null;
}

function findAll(
  table: keyof MockTables,
  tables: MockTables,
  filters: Array<(row: Record<string, unknown>) => boolean>,
): Record<string, unknown>[] {
  const all = tableRows(table, tables);
  return all.filter((row) => filters.every((f) => f(row)));
}

function tableRows(table: keyof MockTables, tables: MockTables): Record<string, unknown>[] {
  if (table === "event_log") return tables.event_log;
  if (table === "pending_refunds") return tables.pending_refunds;
  if (table === "members_link") {
    return Object.entries(tables.members_link).map(([id, v]) => ({
      pushpress_customer_id: id,
      glofox_user_id: v.glofox_user_id,
      email: v.email,
    }));
  }
  if (table === "slot_mappings") {
    return Object.entries(tables.slot_mappings).map(([id, v]) => ({
      pushpress_calendar_item_id: id,
      glofox_event_id: v.glofox_event_id,
      class_type: v.class_type,
    }));
  }
  if (table === "plan_mappings") {
    return Object.values(tables.plan_mappings);
  }
  if (table === "pushpress_enrollment_links") {
    return Object.values(tables.pushpress_enrollment_links);
  }
  return [];
}

// --- Glofox stub ----------------------------------------------------------

interface CapturingGlofox extends GlofoxClientShape {
  calls: Record<string, unknown[]>;
}

function makeGlofox(overrides: Partial<GlofoxClientShape> = {}): CapturingGlofox {
  const mock = new GlofoxMockClient();
  const calls: Record<string, unknown[]> = {};
  function wrap<K extends keyof GlofoxClientShape>(key: K): GlofoxClientShape[K] {
    // deno-lint-ignore no-explicit-any
    return ((...args: unknown[]) => {
      (calls[key as string] ??= []).push(args);
      const target = overrides[key] ?? (mock[key] as any);
      return target.bind(overrides[key] ? overrides : mock)(...(args as never[]));
    }) as any;
  }
  return {
    retrieveMemberByEmail: wrap("retrieveMemberByEmail"),
    createLead: wrap("createLead"),
    getEventsByTimeRange: wrap("getEventsByTimeRange"),
    createBooking: wrap("createBooking"),
    cancelBooking: wrap("cancelBooking"),
    purchaseMembership: wrap("purchaseMembership"),
    cancelMembership: wrap("cancelMembership"),
    getMemberMemberships: wrap("getMemberMemberships"),
    markAttendance: wrap("markAttendance"),
    updateMember: wrap("updateMember"),
    calls,
  };
}

// =============================================================================
// reservation-canceled
// =============================================================================

Deno.test("reservation-canceled: happy path — DELETE called, success", async () => {
  const tables = newTables();
  tables.event_log.push({
    pushpress_event: "reservation.created",
    handler_status: "success",
    payload: { data: { id: "reg_1", reservedId: "cal_1", customerId: "usr_1" } },
    glofox_response: { bookingId: "book_1" },
  });
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleReservationCanceled(
    { event: "reservation.canceled", created: 1, data: { id: "reg_1" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "success");
  assertEquals(glofox.calls.cancelBooking?.length, 1);
  assertEquals(glofox.calls.cancelBooking?.[0], ["book_1"]);
});

Deno.test("reservation-canceled: no prior reservation.created → skipped", async () => {
  const tables = newTables();
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleReservationCanceled(
    { event: "reservation.canceled", created: 1, data: { id: "reg_missing" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "skipped");
  assertEquals(result.error, "no_prior_booking_found");
  assertEquals(glofox.calls.cancelBooking, undefined);
});

Deno.test("reservation-canceled: failed prior row (handler_status=failed) → skipped, not used", async () => {
  const tables = newTables();
  tables.event_log.push({
    pushpress_event: "reservation.created",
    handler_status: "failed",
    payload: { data: { id: "reg_1" } },
    glofox_response: null,
  });
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleReservationCanceled(
    { event: "reservation.canceled", created: 1, data: { id: "reg_1" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "skipped");
  assertEquals(glofox.calls.cancelBooking, undefined);
});

Deno.test("reservation-canceled: Glofox 500 → failed", async () => {
  const tables = newTables();
  tables.event_log.push({
    pushpress_event: "reservation.created",
    handler_status: "success",
    payload: { data: { id: "reg_1" } },
    glofox_response: { bookingId: "book_1" },
  });
  const glofox = makeGlofox({
    cancelBooking: () => {
      throw new GlofoxApiError(500, "/path", "boom");
    },
  });
  // deno-lint-ignore no-explicit-any
  const result = await handleReservationCanceled(
    { event: "reservation.canceled", created: 1, data: { id: "reg_1" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "failed");
});

// =============================================================================
// class-canceled
// =============================================================================

Deno.test("class-canceled: 2 bookings — both DELETEs called, success", async () => {
  const tables = newTables();
  tables.event_log.push({
    pushpress_event: "reservation.created",
    handler_status: "success",
    payload: { data: { id: "reg_a", reservedId: "cal_X", customerId: "usr_a" } },
    glofox_response: { bookingId: "book_a" },
  });
  tables.event_log.push({
    pushpress_event: "reservation.created",
    handler_status: "success",
    payload: { data: { id: "reg_b", reservedId: "cal_X", customerId: "usr_b" } },
    glofox_response: { bookingId: "book_b" },
  });
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleClassCanceled(
    { event: "class.canceled", created: 1, data: { id: "cal_X" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "success");
  assertEquals(glofox.calls.cancelBooking?.length, 2);
  const resp = result.glofoxResponse as { total: number; succeeded: number; failed: number };
  assertEquals(resp.total, 2);
  assertEquals(resp.succeeded, 2);
  assertEquals(resp.failed, 0);
});

Deno.test("class-canceled: no bookings → skipped", async () => {
  const tables = newTables();
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleClassCanceled(
    { event: "class.canceled", created: 1, data: { id: "cal_empty" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "skipped");
  assertEquals(result.error, "no_bookings_to_cancel");
});

Deno.test("class-canceled: one DELETE fails → failed, only failed one enqueued to pending_refunds", async () => {
  const tables = newTables();
  tables.event_log.push({
    pushpress_event: "reservation.created",
    handler_status: "success",
    payload: { data: { id: "reg_a", reservedId: "cal_X", customerId: "usr_a" } },
    glofox_response: { bookingId: "book_a" },
  });
  tables.event_log.push({
    pushpress_event: "reservation.created",
    handler_status: "success",
    payload: { data: { id: "reg_b", reservedId: "cal_X", customerId: "usr_b" } },
    glofox_response: { bookingId: "book_b" },
  });
  let n = 0;
  const glofox = makeGlofox({
    cancelBooking: async (bookingId: string) => {
      n++;
      if (bookingId === "book_b") throw new GlofoxApiError(500, "/path", "fail");
    },
  });
  // deno-lint-ignore no-explicit-any
  const result = await handleClassCanceled(
    { event: "class.canceled", created: 1, data: { id: "cal_X" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "failed");
  assertEquals(n, 2); // both attempted
  assertEquals(tables.pending_refunds.length, 1);
  assertEquals(tables.pending_refunds[0].pushpress_reservation_id, "reg_b");
});

// =============================================================================
// enrollment-status-changed
// =============================================================================

Deno.test("enrollment-status-changed: canceled status + link found → cancelMembership", async () => {
  const tables = newTables();
  tables.pushpress_enrollment_links["enr_1"] = {
    pushpress_enrollment_id: "enr_1",
    pushpress_customer_id: "usr_1",
    glofox_user_membership_id: "umb_1",
    linked_via: "enrollment_created",
  };
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleEnrollmentStatusChanged(
    {
      event: "enrollment.status.changed",
      created: 1,
      data: { id: "enr_1", customerId: "usr_1", status: "canceled" },
    },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "success");
  assertEquals(glofox.calls.cancelMembership?.length, 1);
  assertEquals(glofox.calls.cancelMembership?.[0], ["umb_1"]);
});

Deno.test("enrollment-status-changed: status=paused → skipped, no Glofox call", async () => {
  const tables = newTables();
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleEnrollmentStatusChanged(
    {
      event: "enrollment.status.changed",
      created: 1,
      data: { id: "enr_1", customerId: "usr_1", status: "paused" },
    },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "skipped");
  assert(result.error?.startsWith("non_cancel_transition:paused"));
  assertEquals(glofox.calls.cancelMembership, undefined);
});

Deno.test("enrollment-status-changed: pendcancel + link found → cancelMembership", async () => {
  const tables = newTables();
  tables.pushpress_enrollment_links["enr_2"] = {
    pushpress_enrollment_id: "enr_2",
    pushpress_customer_id: "usr_2",
    glofox_user_membership_id: "umb_2",
    linked_via: "enrollment_created",
  };
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleEnrollmentStatusChanged(
    {
      event: "enrollment.status.changed",
      created: 1,
      data: { id: "enr_2", customerId: "usr_2", status: "pendcancel" },
    },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "success");
  assertEquals(glofox.calls.cancelMembership?.[0], ["umb_2"]);
});

// =============================================================================
// enrollment-deleted
// =============================================================================

Deno.test("enrollment-deleted: link found with id → cancel", async () => {
  const tables = newTables();
  tables.pushpress_enrollment_links["enr_d"] = {
    pushpress_enrollment_id: "enr_d",
    pushpress_customer_id: "usr_d",
    glofox_user_membership_id: "umb_d",
    linked_via: "enrollment_created",
  };
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleEnrollmentDeleted(
    { event: "enrollment.deleted", created: 1, data: { id: "enr_d" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "success");
  assertEquals(glofox.calls.cancelMembership?.[0], ["umb_d"]);
});

Deno.test("enrollment-deleted: link missing → skipped", async () => {
  const tables = newTables();
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleEnrollmentDeleted(
    { event: "enrollment.deleted", created: 1, data: { id: "enr_missing" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "skipped");
  assertEquals(result.error, "no_enrollment_link_for_deleted_id");
});

Deno.test("enrollment-deleted: link found but userMembershipId null → skipped", async () => {
  const tables = newTables();
  tables.pushpress_enrollment_links["enr_n"] = {
    pushpress_enrollment_id: "enr_n",
    pushpress_customer_id: "usr_n",
    glofox_user_membership_id: null,
    linked_via: "enrollment_created",
  };
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleEnrollmentDeleted(
    { event: "enrollment.deleted", created: 1, data: { id: "enr_n" } },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "skipped");
  assertEquals(result.error, "membership_id_unknown_cannot_cancel");
});

// =============================================================================
// checkin-created
// =============================================================================

Deno.test("checkin-created: looks up prior booking_id → markAttendance with booking_id", async () => {
  const tables = newTables();
  // Seed the prior reservation.created row that the handler looks up
  tables.event_log.push({
    pushpress_event: "reservation.created",
    handler_status: "success",
    payload: { data: { id: "reg_c", reservedId: "cls_c", customerId: "usr_c" } },
    glofox_response: { bookingId: "book_c" },
  });
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleCheckinCreated(
    {
      event: "checkin.created",
      created: 1,
      data: {
        id: "chk_1",
        customer: "usr_c",
        classId: "cls_c",
        timestamp: 1700000000,
        kind: "class",
        role: "attendee",
        result: "success",
      },
    },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "success");
  assertEquals(glofox.calls.markAttendance?.length, 1);
  // Verified shape: markAttendance receives the booking_id, not event_id.
  assertEquals(glofox.calls.markAttendance?.[0], ["book_c"]);
});

Deno.test("checkin-created: kind=appointment → filtered, no event_log lookup", async () => {
  const tables = newTables();
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleCheckinCreated(
    {
      event: "checkin.created",
      created: 1,
      data: {
        id: "chk_2",
        customer: "x",
        classId: "y",
        timestamp: 1,
        kind: "appointment",
        role: "attendee",
        result: "success",
      },
    },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "filtered");
  assertEquals(glofox.calls.markAttendance, undefined);
});

Deno.test("checkin-created: no prior booking found → failed", async () => {
  const tables = newTables();
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleCheckinCreated(
    {
      event: "checkin.created",
      created: 1,
      data: {
        id: "chk_3",
        customer: "usr_unknown",
        classId: "cls_z",
        timestamp: 1,
        kind: "class",
        role: "attendee",
        result: "success",
      },
    },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "failed");
  assertEquals(result.error, "no_prior_booking_for_this_customer_and_class");
});

// =============================================================================
// customer-details-changed
// =============================================================================

Deno.test("customer-details-changed: member linked → updateMember called", async () => {
  const tables = newTables();
  tables.members_link["cust_a"] = { glofox_user_id: "gf_a", email: "a@x" };
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleCustomerDetailsChanged(
    {
      event: "customer.details.changed",
      created: 1,
      data: {
        id: "cust_a",
        name: { first: "Alice", last: "Smith" },
        email: "alice@x",
        phone: "+15555550100",
      },
    },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "success");
  assertEquals(glofox.calls.updateMember?.length, 1);
});

Deno.test("customer-details-changed: member not linked → skipped (no auto-create)", async () => {
  const tables = newTables();
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleCustomerDetailsChanged(
    {
      event: "customer.details.changed",
      created: 1,
      data: {
        id: "cust_unknown",
        name: { first: "U", last: "N" },
        email: "u@x",
      },
    },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "skipped");
  assertEquals(result.error, "member_not_linked");
});

Deno.test("customer-details-changed: missing email → failed", async () => {
  const tables = newTables();
  tables.members_link["cust_b"] = { glofox_user_id: "gf_b", email: "b@x" };
  const glofox = makeGlofox();
  // deno-lint-ignore no-explicit-any
  const result = await handleCustomerDetailsChanged(
    {
      event: "customer.details.changed",
      created: 1,
      data: { id: "cust_b", name: { first: "B", last: "B" } },
    },
    { supabase: mockSupabase(tables) as any, glofox },
  );
  assertEquals(result.status, "failed");
  assertEquals(result.error, "customer payload missing email");
});

// =============================================================================
// reservation-waitlisted
// =============================================================================

Deno.test("reservation-waitlisted: sauna + linked member + slot mapped → createBooking with joinWaitingList=true", async () => {
  _resetForTests();
  Deno.env.set("SAUNA_CLASS_TYPE_ALLOWLIST", "Sauna");
  const tables = newTables();
  tables.members_link["usr_w"] = { glofox_user_id: "gf_w", email: "w@x" };
  tables.slot_mappings["cal_w"] = { glofox_event_id: "gf_event_w", class_type: "Sauna" };
  const glofox = makeGlofox();
  const fakePushpress = {
    getClass: async () => ({ id: "cal_w", classTypeName: "Sauna", start: 1700000000, end: 1700003600 }),
    getCustomer: async () => ({
      id: "usr_w",
      email: "w@x",
      name: { first: "W", last: "X" },
      phone: null,
    }),
    // deno-lint-ignore no-explicit-any
  } as any;

  const result = await handleReservationWaitlisted(
    {
      event: "reservation.waitlisted",
      created: 1,
      data: { id: "reg_w", reservedId: "cal_w", customerId: "usr_w" },
    },
    { supabase: mockSupabase(tables) as never, glofox, pushpress: fakePushpress },
  );
  assertEquals(result.status, "success");
  assertEquals(glofox.calls.createBooking?.length, 1);
  const firstCall = glofox.calls.createBooking?.[0] as unknown[] | undefined;
  const args = firstCall?.[0] as { joinWaitingList?: boolean } | undefined;
  assertEquals(args?.joinWaitingList, true);
  _resetForTests();
});

Deno.test("reservation-waitlisted: non-sauna class type → filtered, no Glofox call", async () => {
  _resetForTests();
  Deno.env.set("SAUNA_CLASS_TYPE_ALLOWLIST", "Sauna");
  const tables = newTables();
  const glofox = makeGlofox();
  const fakePushpress = {
    getClass: async () => ({ id: "cal_cf", classTypeName: "CrossFit", start: 1700000000, end: 1700003600 }),
    // deno-lint-ignore no-explicit-any
  } as any;
  const result = await handleReservationWaitlisted(
    {
      event: "reservation.waitlisted",
      created: 1,
      data: { id: "reg_cf", reservedId: "cal_cf", customerId: "usr_cf" },
    },
    { supabase: mockSupabase(tables) as never, glofox, pushpress: fakePushpress },
  );
  assertEquals(result.status, "filtered");
  assertEquals(glofox.calls.createBooking, undefined);
  _resetForTests();
});
