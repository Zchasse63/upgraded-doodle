// Canonical shared types for the PushPress → Glofox bridge.
// All _shared/ modules import from here. Nothing imports from index.ts.

export type PushPressEventName =
  | "enrollment.created"
  | "enrollment.status.changed"
  | "enrollment.deleted"
  | "reservation.created"
  | "reservation.canceled"
  | "reservation.waitlisted"
  | "checkin.created"
  | "class.canceled"
  | "customer.details.changed";

export interface PushPressWebhookBody {
  event: string;
  created: number; // Unix seconds
  data: Record<string, unknown>;
}

export interface HandlerResult {
  status: "success" | "failed" | "skipped" | "filtered";
  error?: string;
  glofoxResponse?: unknown;
}

export type HandlerStatus =
  | "pending"
  | "success"
  | "failed"
  | "skipped"
  | "duplicate"
  | "filtered";

export interface GlofoxConfig {
  apiKey: string;
  apiToken: string;
  branchId: string;
  baseUrl?: string;
}

export interface MemberLink {
  pushpressCustomerId: string;
  glofoxUserId: string;
  email: string;
}

export interface SlotMapping {
  pushpressCalendarItemId: string;
  glofoxEventId: string;
  classType: string | null;
}

// Test-mode switch for the Glofox client. See _shared/glofox-client.ts.
//   mock     — no network; every method returns canned data. Phase A.
//   readonly — real GETs; WRITEs throw GlofoxWriteBlocked. Phase B.
//   live     — full real client. Phase C and production.
export type GlofoxMode = "mock" | "readonly" | "live";

export interface GlofoxClientShape {
  retrieveMemberByEmail(email: string): Promise<{ _id: string } | null>;
  createLead(args: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
  }): Promise<{ _id: string }>;
  getEventsByTimeRange(
    dateFrom: number,
    dateTo: number,
  ): Promise<Array<{ _id: string; time_start: number; name?: string }>>;
  createBooking(args: { userId: string; eventId: string }): Promise<{ _id: string }>;
  purchaseMembership(args: {
    userId: string;
    membershipId: string;
    planCode: string;
    paymentMethod: string;
    promoCode?: string;
    startDate: string;
  }): Promise<{ userMembershipId: string | null }>;
}

export interface PlanMapping {
  pushpressPlanId: string;
  pushpressPlanName: string;
  glofoxMembershipId: string;
  glofoxPlanCode: string;
  paymentMethod: string;
  glofoxPromoCode: string | null;
  isActive: boolean;
}
