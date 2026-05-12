// Minimal Glofox REST client for PR 1.
//
// Ports the patterns from ~/Code/meridian-fresh/lib/glofox/client.ts:
//   - 3 required headers (x-api-key, x-glofox-api-token, x-glofox-branch-id)
//   - 200+success:false detection (Glofox's missing-auth-header quirk)
//   - rate-limit-friendly pacing (200ms between calls)
//
// PR 1 only needs four endpoints. Other Glofox calls (membership purchase,
// attendance, booking cancel) are PR 2.
//
// IMPORTANT: every call here hits TSG's LIVE production Glofox. Tests must
// stub `fetch` via dependency injection or module mocking. There is no
// sandbox layer between this client and real customer data.

import type {
  GlofoxClientShape,
  GlofoxConfig,
  GlofoxMembershipSummary,
  GlofoxMode,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://gf-api.aws.glofox.com/prod";
const INTER_CALL_DELAY_MS = 200;
const MAX_ERROR_BODY_CHARS = 2048;
// Wall-clock timeout per Glofox request. Supabase Edge Functions cap a single
// invocation at ~30s; without an explicit AbortSignal a hung Glofox connection
// would stall until the runtime killed the isolate, leaving event_log rows
// stuck at 'pending'. 15s gives plenty of headroom against Glofox's typical
// ~200ms latency while staying well under the platform limit.
const REQUEST_TIMEOUT_MS = 15_000;

function clipErrorBody(s: string): string {
  return s.length > MAX_ERROR_BODY_CHARS
    ? `${s.slice(0, MAX_ERROR_BODY_CHARS)}…[truncated ${s.length - MAX_ERROR_BODY_CHARS} chars]`
    : s;
}

export class GlofoxNotConfigured extends Error {
  constructor(missing: string) {
    super(`Glofox not configured: missing ${missing}`);
    this.name = "GlofoxNotConfigured";
  }
}

export class GlofoxApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(`Glofox ${status} ${path}: ${message}`);
    this.name = "GlofoxApiError";
  }
}

export class GlofoxCapacityError extends GlofoxApiError {
  constructor(status: number, path: string, message: string) {
    super(status, path, message);
    this.name = "GlofoxCapacityError";
  }
}

// Thrown by GlofoxReadOnlyClient when a write is attempted. Bridge surfaces
// this as a normal handler failure — no Glofox state changes.
export class GlofoxWriteBlocked extends Error {
  constructor(method: string) {
    super(`Glofox write blocked by GLOFOX_MODE=readonly: ${method}`);
    this.name = "GlofoxWriteBlocked";
  }
}

export interface GlofoxEvent {
  _id: string;
  time_start: number;
  name?: string;
}

export class GlofoxClient implements GlofoxClientShape {
  private readonly baseUrl: string;
  private lastCallAt = 0;

  constructor(private readonly cfg: GlofoxConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  static fromEnv(): GlofoxClient {
    const apiKey = Deno.env.get("GLOFOX_API_KEY");
    const apiToken = Deno.env.get("GLOFOX_API_TOKEN");
    const branchId = Deno.env.get("GLOFOX_BRANCH_ID");
    if (!apiKey) throw new GlofoxNotConfigured("GLOFOX_API_KEY");
    if (!apiToken) throw new GlofoxNotConfigured("GLOFOX_API_TOKEN");
    if (!branchId) throw new GlofoxNotConfigured("GLOFOX_BRANCH_ID");
    return new GlofoxClient({ apiKey, apiToken, branchId });
  }

  // --- Members & leads -----------------------------------------------------

  async retrieveMemberByEmail(email: string): Promise<{ _id: string } | null> {
    // Verified shape (2026-05-11):
    // { page, limit, has_more, total_count,
    //   data: [{ id, namespace, email, type: "MEMBER" }] }
    // Members use `id` here (not `_id` — Glofox is inconsistent across endpoints).
    // Glofox member lookup is case-sensitive — normalize to lowercase before
    // sending. (PushPress can store mixed-case emails like "Zchasse89@gmail.com".)
    try {
      const res = await this.request<{
        total_count?: number;
        data?: Array<{ id?: string; email?: string }>;
      }>("POST", "/v3.0/namespaces/members/retrieve", {
        email: email.toLowerCase(),
      });

      const first = res?.data?.[0];
      return first?.id ? { _id: first.id } : null;
    } catch (err) {
      if (err instanceof GlofoxApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createLead(args: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
  }): Promise<{ _id: string }> {
    // We use POST /2.0/register (not /2.1/.../leads, which is deprecated and
    // returns INVALID_USER_TYPE on every request we've tried — verified
    // 2026-05-11). /2.0/register creates a user with type="member" which is
    // better for tracking anyway; the bridge isn't doing CRM-style lead
    // qualification, it's mirroring CC members into TSG's Glofox.
    //
    // Glofox requires a password on /register but the user won't log in
    // directly (their login lives in PushPress / CC's app). We generate a
    // random placeholder; if the user ever needs Glofox login, they'd reset
    // via forgot-password flow.
    const placeholderPassword = generatePlaceholderPassword();
    const res = await this.request<{
      success?: boolean;
      user?: { _id?: string; id?: string };
      _id?: string;
      id?: string;
    }>("POST", "/2.0/register", {
      email: args.email.toLowerCase(),
      first_name: args.firstName,
      last_name: args.lastName,
      phone: args.phone ?? "",
      password: placeholderPassword,
    });
    const id = res?.user?._id ?? res?.user?.id ?? res?._id ?? res?.id;
    if (!id) {
      throw new GlofoxApiError(
        500,
        "/2.0/register",
        "user registered but response missing _id",
      );
    }
    return { _id: id };
  }

  // --- Events --------------------------------------------------------------

  async getEventsByTimeRange(
    dateFrom: number,
    dateTo: number,
  ): Promise<GlofoxEvent[]> {
    // Verified shape (2026-05-11):
    // { object:"list", page, limit, has_more, total_count,
    //   data: [{ _id, name, time_start, size, booked, status, ... }] }
    //
    // Param names are `start` and `end` (per Glofox's API guide). The
    // PushPress-side handoff doc that became api-surface.md said
    // `date_from`/`date_to` — those are SILENTLY IGNORED by Glofox; with
    // them you get a default page of today's events instead of the
    // requested window. We learned this from a wrong slot mapping in
    // Phase C-1 (2026-05-11).
    const path = `/2.0/events?start=${dateFrom}&end=${dateTo}`;
    const res = await this.request<{ data?: GlofoxEvent[] }>("GET", path);
    return Array.isArray(res?.data) ? res.data : [];
  }

  // --- Bookings ------------------------------------------------------------

  async createBooking(args: {
    userId: string;
    eventId: string;
  }): Promise<{ _id: string }> {
    // Glofox requires `model` + `model_id` on POST bookings or returns
    // 400 MODEL_IS_REQUIRED, MODEL_ID_IS_REQUIRED. The accepted INPUT value
    // is `"event"` (singular, lowercase); Glofox then stores it as `"events"`
    // (plural) on the booking record — input/output asymmetry verified via
    // direct probe 2026-05-11. Sending the plural form (`"events"`) on input
    // is rejected with `INVALID_MODEL`. `model_id` is the event's `_id`.
    const path = `/2.3/branches/${this.cfg.branchId}/bookings`;
    const res = await this.request<{
      success?: boolean;
      _id?: string;
      Booking?: { _id?: string };
      booking?: { id?: string; _id?: string };
    }>("POST", path, {
      user_id: args.userId,
      event_id: args.eventId,
      model: "event",
      model_id: args.eventId,
      charge: false, // CC bills in PushPress; Glofox must NOT charge
      pay_gym: false, // do NOT deduct from member's Glofox credits
    });
    // Verified shape (2026-05-11): { success: true, Booking: { _id, ... } }.
    // Keep legacy fallbacks for resilience but prefer `Booking._id` first.
    const id = res?.Booking?._id ?? res?._id ?? res?.booking?._id ?? res?.booking?.id;
    if (!id) {
      throw new GlofoxApiError(500, path, "booking created but response missing _id");
    }
    return { _id: id };
  }

  async createBookingWaitlisted(args: {
    userId: string;
    eventId: string;
  }): Promise<{ _id: string }> {
    // Same as createBooking but adds status:"WAITING" to land on the waitlist
    // rather than as a confirmed booking. Glofox waitlist field is documented
    // in api-surface.md but unverified end-to-end — log the response shape so
    // we can confirm on the first live call.
    const path = `/2.3/branches/${this.cfg.branchId}/bookings`;
    const res = await this.request<{
      success?: boolean;
      _id?: string;
      Booking?: { _id?: string; status?: string };
      booking?: { id?: string; _id?: string };
    }>("POST", path, {
      user_id: args.userId,
      event_id: args.eventId,
      model: "event",
      model_id: args.eventId,
      status: "WAITING",
      charge: false,
      pay_gym: false,
    });
    const id = res?.Booking?._id ?? res?._id ?? res?.booking?._id ?? res?.booking?.id;
    if (!id) {
      throw new GlofoxApiError(500, path, "waitlist booking created but response missing _id");
    }
    return { _id: id };
  }

  async cancelBooking(bookingId: string): Promise<void> {
    // Glofox's DELETE returns 204 on success. For an already-canceled or
    // non-existent booking, Glofox returns **400 BOOKING_NOT_FOUND** (verified
    // 2026-05-11 via direct probe). It does NOT return 404 here, despite the
    // semantic — Glofox tags missing-resource errors as 400 with a 200+
    // success:false envelope, which our request() normalizes to GlofoxApiError
    // status=400. We treat both as idempotent success.
    const path = `/2.3/branches/${this.cfg.branchId}/bookings/${
      encodeURIComponent(bookingId)
    }`;
    try {
      await this.request<unknown>("DELETE", path);
    } catch (err) {
      if (err instanceof GlofoxApiError) {
        if (err.status === 404) return;
        if (err.status === 400 && /BOOKING_NOT_FOUND/i.test(err.message)) return;
      }
      throw err;
    }
  }

  // --- Memberships --------------------------------------------------------

  async purchaseMembership(args: {
    userId: string;
    membershipId: string;
    planCode: string;
    paymentMethod: string;
    promoCode?: string;
    startDate: string;
  }): Promise<{ userMembershipId: string | null }> {
    const path = `/2.2/branches/${this.cfg.branchId}/users/${
      encodeURIComponent(args.userId)
    }/memberships/${encodeURIComponent(args.membershipId)}/plans/${
      encodeURIComponent(args.planCode)
    }/purchase`;

    // Build the body conditionally — Glofox might treat promo_code:null as
    // "apply empty promo" vs absent as "no promo at all". Omit when not set.
    //
    // start_date as a Unix timestamp string. Glofox's PHP backend internally
    // prepends `@` to whatever we send and feeds it to DateTime::__construct,
    // which only accepts Unix timestamps in that form. Sending "2026-05-11"
    // → "@2026-05-11" → "Double timezone specification" error (2026 parsed
    // as a tiny Unix timestamp, the rest as a timezone offset).
    const startTs = parseStartDateToUnix(args.startDate);
    const body: Record<string, unknown> = {
      payment_method: args.paymentMethod,
      start_date: String(startTs),
    };
    if (args.promoCode !== undefined) body.promo_code = args.promoCode;

    // Response shape is unverified (will discover on first live replay).
    // Defensive parser — try candidate ID locations scoped under `data`
    // (the conventional Glofox v2.x envelope). Avoid top-level `res.id`:
    // some Glofox responses use top-level `id` for trace / envelope IDs
    // rather than the resource ID, which would store the WRONG identifier
    // and break PR 3's cancel-by-userMembershipId lookup.
    //
    // If none present but Glofox returned 2xx, return null — the
    // membership was assigned if Glofox returned 2xx; failing here would
    // cause replay double-assign.
    const res = await this.request<{
      data?: {
        _id?: string;
        userMembershipId?: string;
        id?: string;
        membership?: { _id?: string };
      };
    }>("POST", path, body);

    let userMembershipId: string | null = null;
    let matchedPath = "<none>";
    if (res?.data?._id) {
      userMembershipId = res.data._id;
      matchedPath = "data._id";
    } else if (res?.data?.userMembershipId) {
      userMembershipId = res.data.userMembershipId;
      matchedPath = "data.userMembershipId";
    } else if (res?.data?.id) {
      userMembershipId = res.data.id;
      matchedPath = "data.id";
    } else if (res?.data?.membership?._id) {
      userMembershipId = res.data.membership._id;
      matchedPath = "data.membership._id";
    }

    // Log the actual response shape on first call so we can confirm the
    // parser is hitting the right field on the real Glofox response.
    console.error(
      JSON.stringify({
        level: userMembershipId ? "info" : "warn",
        msg: "purchaseMembership response parsed",
        path,
        matched_path: matchedPath,
        has_id: !!userMembershipId,
      }),
    );

    return { userMembershipId };
  }

  async cancelMembership(userMembershipId: string): Promise<void> {
    // POST /v3.0/memberships/{userMembershipId}/cancel — no body required.
    // Per api-surface.md: idempotent on already-canceled membership; verify
    // first live call. We treat 404 as success (already canceled).
    const path = `/v3.0/memberships/${encodeURIComponent(userMembershipId)}/cancel`;
    try {
      await this.request<unknown>("POST", path);
    } catch (err) {
      if (err instanceof GlofoxApiError && err.status === 404) return;
      throw err;
    }
  }

  async getMemberMemberships(userId: string): Promise<GlofoxMembershipSummary[]> {
    // GET /2.0/branches/{branchId}/users/{userId}/memberships — used by the
    // cancel handlers' DQ7 fallback when pushpress_enrollment_links doesn't
    // have the userMembershipId cached.
    //
    // Response shape unverified end-to-end; defensive parse. We try the
    // conventional Glofox v2.x list envelope (data: [...]) and fall back to
    // a top-level array.
    const path = `/2.0/branches/${this.cfg.branchId}/users/${
      encodeURIComponent(userId)
    }/memberships?private=any`;
    const res = await this.request<unknown>("GET", path);
    const items: unknown = Array.isArray(res)
      ? res
      : (res as { data?: unknown })?.data;
    if (!Array.isArray(items)) return [];

    return items.flatMap((raw): GlofoxMembershipSummary[] => {
      if (!raw || typeof raw !== "object") return [];
      const obj = raw as Record<string, unknown>;
      const _id = typeof obj._id === "string"
        ? obj._id
        : typeof obj.id === "string"
        ? obj.id
        : null;
      const membership_id = typeof obj.membership_id === "string"
        ? obj.membership_id
        : typeof obj.membershipId === "string"
        ? obj.membershipId
        : "";
      const status = typeof obj.status === "string" ? obj.status : "";
      return _id ? [{ _id, membership_id, status }] : [];
    });
  }

  // --- Attendance & Profile -----------------------------------------------

  async markAttendance(args: {
    userId: string;
    eventId: string;
    attendedAt: number;
  }): Promise<void> {
    // Attendance uses a DIFFERENT input shape than bookings:
    //   - model_ids (plural, ARRAY) not model_id (sing)
    //   - model: "events" (plural) not "event" (sing)
    // Verified 2026-05-11 via direct probe. Singular variants return
    // "Invalid model or model_ids" or "The model is not implemented".
    //
    // SEMANTIC NOTE (also verified 2026-05-11): the attendance endpoint
    // appears to resolve the booking server-side from (event, model_ids) and
    // may attribute attendance to the wrong user when multiple bookings exist
    // for the event. This needs end-to-end verification in TSG's dashboard
    // before any checkin.created handler invocation can be trusted in
    // production. Open question — see docs/open-questions.md (Q12, new).
    await this.request<unknown>("POST", "/2.0/attendances", {
      user_id: args.userId,
      model: "events",
      model_ids: [args.eventId],
      attended_at: args.attendedAt,
    });
  }

  async updateMember(args: {
    userId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
  }): Promise<void> {
    await this.request<unknown>(
      "PUT",
      `/2.0/members/${encodeURIComponent(args.userId)}`,
      {
        first_name: args.firstName,
        last_name: args.lastName,
        email: args.email.toLowerCase(),
        phone: args.phone ?? "",
      },
    );
  }

  // --- Private --------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    await this.pace();

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "x-api-key": this.cfg.apiKey,
      "x-glofox-api-token": this.cfg.apiToken,
      "x-glofox-branch-id": this.cfg.branchId,
    };
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const init: RequestInit = { method, headers, signal: ctrl.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res: Response;
    let text: string;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError"
        ? `request timeout after ${REQUEST_TIMEOUT_MS}ms`
        : err instanceof Error
        ? err.message
        : String(err);
      throw new GlofoxApiError(0, path, msg);
    } finally {
      clearTimeout(timeoutId);
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON response — keep null; error path below handles it
    }

    // Glofox returns 200+success:false when any of the three auth headers
    // is missing. Treat as a 400.
    if (json && typeof json === "object" && (json as Record<string, unknown>).success === false) {
      throw new GlofoxApiError(400, path, clipErrorBody(text));
    }

    if (!res.ok) {
      // Best-guess capacity detection. Q4 in open-questions.md tracks the
      // exact response shape for capacity-full — refine when verified.
      const clipped = clipErrorBody(text);
      if (/capaci|full/i.test(text)) {
        throw new GlofoxCapacityError(res.status, path, clipped);
      }
      throw new GlofoxApiError(res.status, path, clipped);
    }

    return json as T;
  }

  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < INTER_CALL_DELAY_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, INTER_CALL_DELAY_MS - elapsed)
      );
    }
    this.lastCallAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// GlofoxReadOnlyClient — wraps a real client; throws on writes.
// Used in Phase B: validates auth + read shapes against live Glofox without
// allowing any state change.
// ---------------------------------------------------------------------------

export class GlofoxReadOnlyClient implements GlofoxClientShape {
  constructor(private readonly inner: GlofoxClient) {}

  retrieveMemberByEmail(email: string) {
    return this.inner.retrieveMemberByEmail(email);
  }

  getEventsByTimeRange(dateFrom: number, dateTo: number) {
    return this.inner.getEventsByTimeRange(dateFrom, dateTo);
  }

  getMemberMemberships(userId: string) {
    return this.inner.getMemberMemberships(userId);
  }

  createLead(_args: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
  }): Promise<{ _id: string }> {
    return Promise.reject(new GlofoxWriteBlocked("createLead"));
  }

  createBooking(_args: {
    userId: string;
    eventId: string;
  }): Promise<{ _id: string }> {
    return Promise.reject(new GlofoxWriteBlocked("createBooking"));
  }

  createBookingWaitlisted(_args: {
    userId: string;
    eventId: string;
  }): Promise<{ _id: string }> {
    return Promise.reject(new GlofoxWriteBlocked("createBookingWaitlisted"));
  }

  cancelBooking(_bookingId: string): Promise<void> {
    return Promise.reject(new GlofoxWriteBlocked("cancelBooking"));
  }

  purchaseMembership(_args: {
    userId: string;
    membershipId: string;
    planCode: string;
    paymentMethod: string;
    promoCode?: string;
    startDate: string;
  }): Promise<{ userMembershipId: string | null }> {
    return Promise.reject(new GlofoxWriteBlocked("purchaseMembership"));
  }

  cancelMembership(_userMembershipId: string): Promise<void> {
    return Promise.reject(new GlofoxWriteBlocked("cancelMembership"));
  }

  markAttendance(_args: {
    userId: string;
    eventId: string;
    attendedAt: number;
  }): Promise<void> {
    return Promise.reject(new GlofoxWriteBlocked("markAttendance"));
  }

  updateMember(_args: {
    userId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
  }): Promise<void> {
    return Promise.reject(new GlofoxWriteBlocked("updateMember"));
  }
}

// ---------------------------------------------------------------------------
// GlofoxMockClient — never hits the network. Used in Phase A.
// Behavior is deterministic and matches the contract of the real client:
//   retrieveMemberByEmail → returns a fixed _id for any email
//   createLead            → returns a fixed _id
//   getEventsByTimeRange  → returns one synthetic event named "Sauna"
//                            centered on the requested window
//   createBooking         → returns a fixed booking _id
// ---------------------------------------------------------------------------

export class GlofoxMockClient implements GlofoxClientShape {
  retrieveMemberByEmail(_email: string): Promise<{ _id: string } | null> {
    return Promise.resolve({ _id: "mock-glofox-member-id" });
  }

  createLead(_args: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
  }): Promise<{ _id: string }> {
    return Promise.resolve({ _id: "mock-glofox-lead-id" });
  }

  getEventsByTimeRange(
    dateFrom: number,
    dateTo: number,
  ): Promise<Array<{ _id: string; time_start: number; name?: string }>> {
    const center = Math.floor((dateFrom + dateTo) / 2);
    return Promise.resolve([
      { _id: "mock-glofox-event-id", time_start: center, name: "Sauna" },
    ]);
  }

  createBooking(_args: {
    userId: string;
    eventId: string;
  }): Promise<{ _id: string }> {
    return Promise.resolve({ _id: "mock-glofox-booking-id" });
  }

  createBookingWaitlisted(_args: {
    userId: string;
    eventId: string;
  }): Promise<{ _id: string }> {
    return Promise.resolve({ _id: "mock-glofox-waitlist-booking-id" });
  }

  cancelBooking(_bookingId: string): Promise<void> {
    return Promise.resolve();
  }

  purchaseMembership(_args: {
    userId: string;
    membershipId: string;
    planCode: string;
    paymentMethod: string;
    promoCode?: string;
    startDate: string;
  }): Promise<{ userMembershipId: string | null }> {
    return Promise.resolve({ userMembershipId: "mock-glofox-user-membership-id" });
  }

  cancelMembership(_userMembershipId: string): Promise<void> {
    return Promise.resolve();
  }

  getMemberMemberships(_userId: string): Promise<GlofoxMembershipSummary[]> {
    return Promise.resolve([
      { _id: "mock-glofox-user-membership-id", membership_id: "mock-mid", status: "ACTIVE" },
    ]);
  }

  markAttendance(_args: {
    userId: string;
    eventId: string;
    attendedAt: number;
  }): Promise<void> {
    return Promise.resolve();
  }

  updateMember(_args: {
    userId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
  }): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Factory — reads GLOFOX_MODE and returns the right client. Default is "live".
// ---------------------------------------------------------------------------

// Glofox's PHP backend prepends `@` and feeds the start_date string through
// PHP's DateTime::__construct, which expects either an integer Unix timestamp
// or a string already starting with `@<integer>`. Anything else (e.g.
// "2026-05-11") produces a 400. So we always send a Unix-seconds string.
// Random placeholder password for auto-created Glofox users. They won't use
// this to log in (the bridge controls assignment from PushPress); if they
// ever need Glofox direct access, they reset via forgot-password.
function generatePlaceholderPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  // Glofox-likely password requirements: include letter, number, symbol.
  return `Bridge-${hex.slice(0, 16)}!`;
}

function parseStartDateToUnix(startDate: string): number {
  // Accept "YYYY-MM-DD", full ISO with timezone, or already-numeric string.
  const trimmed = startDate.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  // Date-only — anchor to UTC midnight so we never trip on "no time" parsing.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const iso = dateOnly ? `${trimmed}T00:00:00Z` : trimmed;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}

export function glofoxClientFromEnv(): GlofoxClientShape {
  const mode = (Deno.env.get("GLOFOX_MODE") ?? "live") as GlofoxMode;

  if (mode === "mock") {
    console.error(
      JSON.stringify({
        level: "warn",
        msg: "GLOFOX_MODE=mock — no real Glofox calls will be made",
      }),
    );
    return new GlofoxMockClient();
  }

  if (mode === "readonly") {
    console.error(
      JSON.stringify({
        level: "warn",
        msg: "GLOFOX_MODE=readonly — Glofox writes will be blocked",
      }),
    );
    return new GlofoxReadOnlyClient(GlofoxClient.fromEnv());
  }

  return GlofoxClient.fromEnv();
}
