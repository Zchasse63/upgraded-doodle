// Thin PushPress REST client. Hand-rolled, no SDK.
//
// Why not the SDK: @pushpress/pushpress@1.15.0 is alpha-labeled, generated
// by Speakeasy with dual-export resolution that's an unknown failure mode
// at Deno Edge Function cold-start. A cold-start import failure means 500s
// on every webhook delivery until redeploy. The two endpoints we need are
// 10 lines each.
//
// PR 1 needs only:
//   - GET /customers/{id}  → resolves email for member-link
//   - GET /classes/{id}    → resolves classTypeName for sauna filter
//                          + start/end for slot mapping window
//
// Other PushPress operations (manageWebhooks.create, messages.push.send)
// live in scripts/ where we DO use the SDK — alpha risk is acceptable for
// local operator tooling, not for the production Edge Function.

const DEFAULT_BASE_URL = "https://api.pushpress.com/v3";
const MAX_ERROR_BODY_CHARS = 2048;
// Wall-clock per-request timeout. Edge Functions cap at ~30s total; an
// unresponsive PushPress would otherwise stall the handler and leave the
// event_log row stuck at 'pending'. Lower than the Glofox timeout because
// our PushPress reads (getCustomer, getClass, getPlan) are typically much
// faster than Glofox writes.
const REQUEST_TIMEOUT_MS = 10_000;

function clipErrorBody(s: string): string {
  return s.length > MAX_ERROR_BODY_CHARS
    ? `${s.slice(0, MAX_ERROR_BODY_CHARS)}…[truncated ${s.length - MAX_ERROR_BODY_CHARS} chars]`
    : s;
}

export class PushPressNotConfigured extends Error {
  constructor(missing: string) {
    super(`PushPress not configured: missing ${missing}`);
    this.name = "PushPressNotConfigured";
  }
}

export class PushPressApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(`PushPress ${status} ${path}: ${message}`);
    this.name = "PushPressApiError";
  }
}

export interface PushPressCustomer {
  id: string;
  email: string;
  name: { first: string; last: string };
  phone?: string | null;
}

export interface PushPressClass {
  id: string;
  classTypeName?: string | null;
  start: number; // Unix seconds
  end: number;
}

export interface PushPressPlan {
  id: string;
  name: string;
  companyId: string;
  category: { name: string };
}

export class PushPressClient {
  private readonly baseUrl: string;

  constructor(
    private readonly cfg: { apiKey: string; companyId: string; serverUrl?: string },
  ) {
    this.baseUrl = (cfg.serverUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  static fromEnv(): PushPressClient {
    const apiKey = Deno.env.get("PUSHPRESS_API_KEY");
    const companyId = Deno.env.get("PUSHPRESS_COMPANY_ID");
    if (!apiKey) throw new PushPressNotConfigured("PUSHPRESS_API_KEY");
    if (!companyId) throw new PushPressNotConfigured("PUSHPRESS_COMPANY_ID");

    const server = Deno.env.get("PUSHPRESS_SERVER") ?? "production";
    const serverUrl =
      server === "staging"
        ? "https://api.pushpressstage.com/v3"
        : server === "development"
        ? "https://api.pushpressdev.com/v3"
        : DEFAULT_BASE_URL;

    return new PushPressClient({ apiKey, companyId, serverUrl });
  }

  async getCustomer(customerId: string): Promise<PushPressCustomer> {
    const raw = await this.request<{
      id: string;
      email: string;
      name?: { first?: string; last?: string };
      phone?: string | null;
    }>(`/customers/${encodeURIComponent(customerId)}`);

    return {
      id: raw.id,
      email: raw.email,
      name: { first: raw.name?.first ?? "", last: raw.name?.last ?? "" },
      phone: raw.phone ?? null,
    };
  }

  async getClass(classId: string): Promise<PushPressClass> {
    const raw = await this.request<{
      id: string;
      classTypeName?: string | null;
      start: number;
      end: number;
    }>(`/classes/${encodeURIComponent(classId)}`);

    return {
      id: raw.id,
      classTypeName: raw.classTypeName ?? null,
      start: raw.start,
      end: raw.end,
    };
  }

  async getPlan(planId: string): Promise<PushPressPlan> {
    const raw = await this.request<{
      id: string;
      name: string;
      companyId: string;
      category?: { name?: string };
    }>(`/plans/${encodeURIComponent(planId)}`);

    return {
      id: raw.id,
      name: raw.name,
      companyId: raw.companyId,
      category: { name: raw.category?.name ?? "" },
    };
  }

  private async request<T>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          "API-KEY": this.cfg.apiKey,
          "company-id": this.cfg.companyId,
          "Content-Type": "application/json",
        },
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError"
        ? `request timeout after ${REQUEST_TIMEOUT_MS}ms`
        : err instanceof Error
        ? err.message
        : String(err);
      throw new PushPressApiError(0, path, msg);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      throw new PushPressApiError(res.status, path, clipErrorBody(text));
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PushPressApiError(res.status, path, `invalid JSON: ${clipErrorBody(text)}`);
    }
  }
}
