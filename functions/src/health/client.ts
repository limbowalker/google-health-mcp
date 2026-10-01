import { getDataType } from "./datatypes.js";
import { addDays, toCivil } from "./time.js";

export type DataSourceFamily = "all-sources" | "google-wearables" | "google-sources" | "self-sources";
export const DATA_SOURCE_FAMILIES: DataSourceFamily[] = ["all-sources", "google-wearables", "google-sources", "self-sources"];

export class HealthApiError extends Error {
  constructor(
    readonly status: number,
    readonly apiStatus: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

// Loosely typed API payloads: the MCP layer summarizes them rather than passing them through.
export type Json = Record<string, any>;

export interface HealthClientOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  /** Called when the API rejects the access token, so the next attempt refreshes it. */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | boolean | undefined>;

/** Thin REST client for https://health.googleapis.com/v4 with retry/backoff on 429 and 5xx. */
export class HealthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HealthClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T = Json>(method: "GET" | "POST" | "PATCH", path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.opts.baseUrl}/v4/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.getAccessToken();
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (res.status === 401 && attempt === 0) {
        this.opts.onUnauthorized?.();
        continue;
      }
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(500 * 2 ** attempt + Math.random() * 250);
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as Json;
      throw new HealthApiError(res.status, body.error?.status, body.error?.message ?? `HTTP ${res.status}`);
    }
  }

  getProfile() {
    return this.request("GET", "users/me/profile");
  }
  getSettings() {
    return this.request("GET", "users/me/settings");
  }
  getIdentity() {
    return this.request("GET", "users/me/identity");
  }
  listPairedDevices() {
    return this.request("GET", "users/me/pairedDevices", { query: { pageSize: 100 } });
  }
  updateSettings(settings: Json, fields: string[]) {
    return this.request("PATCH", "users/me/settings", {
      query: { updateMask: fields.join(",") },
      body: { name: "users/me/settings", ...settings },
    });
  }
  updateProfile(profile: Json, fields: string[]) {
    return this.request("PATCH", "users/me/profile", {
      query: { updateMask: fields.join(",") },
      body: { name: "users/me/profile", ...profile },
    });
  }

  /** One page of raw (`list`) or deduplicated (`reconcile`) data points. */
  async page(
    mode: "list" | "reconcile",
    type: string,
    opts: { filter?: string; pageSize?: number; pageToken?: string; family?: DataSourceFamily },
  ): Promise<{ dataPoints: Json[]; nextPageToken?: string }> {
    const suffix = mode === "reconcile" ? ":reconcile" : "";
    const res = await this.request("GET", `users/me/dataTypes/${type}/dataPoints${suffix}`, {
      query: {
        filter: opts.filter,
        pageSize: opts.pageSize,
        pageToken: opts.pageToken,
        dataSourceFamily: mode === "reconcile" && opts.family ? familyName(opts.family) : undefined,
      },
    });
    return { dataPoints: res.dataPoints ?? [], nextPageToken: res.nextPageToken || undefined };
  }

  /** Follows pagination until exhausted or `maxItems` points were collected. */
  async collect(
    mode: "list" | "reconcile",
    type: string,
    opts: { filter?: string; family?: DataSourceFamily; pageSize?: number },
    maxItems: number,
  ): Promise<{ dataPoints: Json[]; truncated: boolean }> {
    const all: Json[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.page(mode, type, { ...opts, pageToken });
      all.push(...page.dataPoints);
      pageToken = page.nextPageToken;
    } while (pageToken && all.length < maxItems);
    return { dataPoints: all.slice(0, maxItems), truncated: Boolean(pageToken) || all.length > maxItems };
  }

  /** Physical-time rollup (`windowSize` in seconds), following pagination. */
  async rollUp(
    type: string,
    opts: { startTime: string; endTime: string; windowSec: number; family?: DataSourceFamily; maxPoints?: number },
  ): Promise<Json[]> {
    const out: Json[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.request("POST", `users/me/dataTypes/${type}/dataPoints:rollUp`, {
        body: {
          range: { startTime: opts.startTime, endTime: opts.endTime },
          windowSize: `${opts.windowSec}s`,
          dataSourceFamily: opts.family ? familyName(opts.family) : undefined,
          pageSize: 10000,
          pageToken,
        },
      });
      out.push(...(res.rollupDataPoints ?? []));
      pageToken = res.nextPageToken || undefined;
    } while (pageToken && out.length < (opts.maxPoints ?? 10000));
    return out;
  }

  /**
   * Civil-day rollup over [start, endExclusive), split into chunks that respect the per-type
   * range limit (14 or 90 days). Returns one entry per day that has a value.
   */
  async dailyRollUp(type: string, start: string, endExclusive: string, family?: DataSourceFamily): Promise<Json[]> {
    const { maxRollupDays } = getDataType(type);
    const chunks: [string, string][] = [];
    for (let s = start; s < endExclusive; ) {
      const e = addDays(s, maxRollupDays) < endExclusive ? addDays(s, maxRollupDays) : endExclusive;
      chunks.push([s, e]);
      s = e;
    }
    const fetchChunk = ([s, e]: [string, string]) =>
      this.request("POST", `users/me/dataTypes/${type}/dataPoints:dailyRollUp`, {
        body: {
          range: { start: { date: toCivil(s) }, end: { date: toCivil(e) } },
          windowSizeDays: 1,
          dataSourceFamily: family ? familyName(family) : undefined,
        },
      });
    const results: Json[] = [];
    // A year of a 14-day-limited type is 27 chunks; send at most 4 at a time.
    for (let i = 0; i < chunks.length; i += 4) {
      results.push(...(await Promise.all(chunks.slice(i, i + 4).map(fetchChunk))));
    }
    return results.flatMap((r) => r.rollupDataPoints ?? []);
  }

  create(type: string, dataPoint: Json) {
    return this.request("POST", `users/me/dataTypes/${type}/dataPoints`, { body: dataPoint });
  }

  batchDelete(type: string, names: string[]) {
    return this.request("POST", `users/me/dataTypes/${type}/dataPoints:batchDelete`, { body: { names } });
  }
}

export function familyName(family: DataSourceFamily): string {
  return `users/me/dataSourceFamilies/${family}`;
}
