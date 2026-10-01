import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { pkceChallenge } from "../src/auth/crypto.js";
import { READ_SCOPES, WRITE_SCOPES, type GoogleOAuth } from "../src/auth/google.js";
import { buildConfig } from "../src/config.js";
import { MemoryStore } from "../src/store/memory.js";

const fakeGoogle: GoogleOAuth = {
  buildAuthUrl: ({ state, write }) => `https://accounts.example/auth?state=${state}&write=${write}`,
  exchangeCode: async () => ({
    sub: "google-sub-1",
    email: "user@example.com",
    accessToken: "google-access",
    expiresIn: 3600,
    refreshToken: "google-refresh",
    scopes: [...READ_SCOPES, ...WRITE_SCOPES],
  }),
  refresh: async () => ({ accessToken: "google-access-2", expiresIn: 3600 }),
  revoke: async () => {},
};

/** Minimal Google Health API stand-in, recording write requests. */
const writes: { path: string; body: any }[] = [];
const fakeHealthFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const path = url.pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  if (path === "/v4/users/me/identity") return json({ healthUserId: "hu-1" });
  if (path === "/v4/users/me/settings") return json({ timeZone: "Europe/Warsaw", weightUnit: "WEIGHT_UNIT_KILOGRAMS" });
  if (path === "/v4/users/me/profile") return json({ age: 36 });
  if (path === "/v4/users/me/pairedDevices") return json({ pairedDevices: [{ deviceVersion: "Charge 6", lastSyncTime: "2026-09-29T07:00:00Z" }] });

  const m = /^\/v4\/users\/me\/dataTypes\/([a-z-]+)\/dataPoints(:\w+)?$/.exec(path);
  if (!m) return json({ error: { status: "NOT_FOUND", message: path } }, 404);
  const [, type, verb] = m;
  if (verb === ":dailyRollUp") {
    const start = body.range.start.date;
    const date = { year: start.year, month: start.month, day: start.day };
    const values: Record<string, unknown> = {
      steps: { steps: { countSum: "10500" } },
      "total-calories": { totalCalories: { kcalSum: 2500 } },
      "nutrition-log": { nutritionLog: { energy: { kcalSum: 2000 }, nutrients: [{ nutrient: "PROTEIN", quantity: { gramsSum: 140 } }] } },
      weight: { weight: { weightGramsAvg: 82000 } },
    };
    return json({ rollupDataPoints: values[type] ? [{ civilStartTime: { date }, ...(values[type] as object) }] : [] });
  }
  if (verb === ":reconcile" && type === "daily-resting-heart-rate") {
    return json({ dataPoints: [{ dailyRestingHeartRate: { date: { year: 2026, month: 9, day: 28 }, beatsPerMinute: "56" } }] });
  }
  if (verb === ":batchDelete") {
    writes.push({ path, body });
    return json({ done: true, response: {} });
  }
  if (!verb && init?.method === "POST") {
    writes.push({ path, body });
    return json({ done: true, response: { ...body, name: `users/hu-1/dataTypes/${type}/dataPoints/new-1` } });
  }
  if (!verb && type === "nutrition-log") {
    return json({
      dataPoints: [
        {
          name: "users/hu-1/dataTypes/nutrition-log/dataPoints/n1",
          dataSource: { platform: "HEALTH_KIT", application: { packageName: "com.myfitnesspal" } },
          nutritionLog: {
            interval: { startTime: "2026-09-28T10:00:00Z", startUtcOffset: "7200s", endTime: "2026-09-28T10:01:00Z", endUtcOffset: "7200s" },
            foodDisplayName: "Oats",
            energy: { kcal: 350 },
          },
        },
      ],
    });
  }
  return json({ dataPoints: [] });
};

let server: Server;
let base: string;
const redirectUri = "http://localhost:9999/callback";
const verifier = "test-verifier-0123456789-0123456789-0123456789";
let clientId: string;
let accessToken: string;
let refreshToken: string;

beforeAll(async () => {
  const app = createApp({
    config: buildConfig({
      baseUrl: "http://localhost:1",
      googleClientId: "gid",
      googleClientSecret: "gsecret",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    }),
    store: new MemoryStore(),
    google: fakeGoogle,
    fetchImpl: fakeHealthFetch,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

async function mcp(method: string, params: unknown = {}, token = accessToken) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { body } = await mcp("tools/call", { name, arguments: args });
  const text = body.result?.content?.[0]?.text;
  return { isError: body.result?.isError === true, text, data: body.result?.isError ? undefined : JSON.parse(text) };
}

describe("OAuth authorization server", () => {
  it("publishes discovery metadata", async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe("http://localhost:1/mcp");
    expect(prm.authorization_servers).toEqual(["http://localhost:1/"]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.registration_endpoint).toBe("http://localhost:1/register");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("challenges unauthenticated MCP requests", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('resource_metadata="http://localhost:1/.well-known/oauth-protected-resource/mcp"');
  });

  it("rejects non-loopback http redirect URIs at registration", async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"], token_endpoint_auth_method: "none" }),
    });
    expect(res.status).toBe(400);
  });

  it("runs the full authorization code flow with PKCE", async () => {
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", client_name: "Test <Agent>" }),
    });
    expect(reg.status).toBe(201);
    clientId = (await reg.json()).client_id;

    const authorize = new URL(`${base}/authorize`);
    authorize.search = form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://localhost:4321/callback", // loopback: any port is accepted
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "st-1",
      resource: "http://localhost:1/mcp",
    });
    const consent = await fetch(authorize, { redirect: "manual" });
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain("Test &lt;Agent&gt;");
    expect(html).toContain("localhost:4321");
    expect(html).toContain("Local app"); // loopback-only client warning
    const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1];
    const cookie = consent.headers.get("set-cookie")!.split(";")[0];

    // Consent from a different browser (no binding cookie) is refused.
    const csrf = await fetch(`${base}/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ request_id: requestId, action: "approve", access: "write" }),
      redirect: "manual",
    });
    expect(csrf.status).toBe(400);

    const approve = await fetch(`${base}/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: form({ request_id: requestId, action: "approve", access: "write" }),
      redirect: "manual",
    });
    expect(approve.status).toBe(303);
    const google = new URL(approve.headers.get("location")!);
    expect(google.searchParams.get("write")).toBe("true");

    const callback = await fetch(`${base}/oauth/google/callback?state=${google.searchParams.get("state")}&code=gcode`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("http://localhost:4321/callback");
    expect(back.searchParams.get("state")).toBe("st-1");
    const code = back.searchParams.get("code")!;

    const tokenReq = (codeVerifier: string) =>
      fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: "http://localhost:4321/callback",
        }),
      });
    expect((await tokenReq("wrong-verifier-wrong-verifier-wrong-verifier")).status).toBe(400);
    const ok = await tokenReq(verifier);
    expect(ok.status).toBe(200);
    const tokens = await ok.json();
    expect(tokens.token_type).toBe("Bearer");
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;

    // Codes are single-use.
    expect((await tokenReq(verifier)).status).toBe(400);
  });

  it("rotates refresh tokens", async () => {
    const refresh = (token: string) =>
      fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }),
      });
    const res = await refresh(refreshToken);
    expect(res.status).toBe(200);
    const next = await res.json();
    expect(next.access_token).not.toBe(accessToken);
    // Claude requires the RFC 6749 code for a dead refresh token.
    const reused = await refresh(refreshToken);
    expect(reused.status).toBe(400);
    expect((await reused.json()).error).toBe("invalid_grant");
    accessToken = next.access_token;
    refreshToken = next.refresh_token;
  });

  it("accepts Claude's hosted callback as a public DCR client", async () => {
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(reg.status).toBe(201);
    const client = await reg.json();
    expect(client.client_secret).toBeUndefined();

    const authorize = new URL(`${base}/authorize`);
    authorize.search = form({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "claude-state",
    });
    const consent = await fetch(authorize, { redirect: "manual" });
    expect(consent.status).toBe(200);
    expect(consent.headers.get("cache-control")).toBe("private, no-store");
    const html = await consent.text();
    expect(html).toContain("<code>claude.ai</code>");
    expect(html).not.toContain("Local app");
  });
});

describe("MCP endpoint", () => {
  it("initializes and lists tools", async () => {
    const init = await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("google-health-mcp");
    expect(init.body.result.instructions).toContain("get_user_context");

    const { body } = await mcp("tools/list");
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_user_context",
        "get_daily_summaries",
        "get_goal_progress",
        "set_goals",
        "log_meal",
        "log_body_measurement",
        "delete_entries",
        "check_data_sources",
      ]),
    );
    const del = body.result.tools.find((t: any) => t.name === "delete_entries");
    expect(del.annotations.destructiveHint).toBe(true);

    const prompts = await mcp("prompts/list");
    expect(prompts.body.result.prompts.map((p: any) => p.name)).toEqual(["weekly_review", "fat_loss_plan", "log_food"]);
  });

  it("returns user context with timezone and goals", async () => {
    const r = await callTool("get_user_context");
    expect(r.isError).toBe(false);
    expect(r.data.timeZone).toBe("Europe/Warsaw");
    expect(r.data.preferredUnits.weight).toBe("kilograms");
    expect(r.data.devices[0].model).toBe("Charge 6");
    expect(r.data.permissions.write).toContain("food and water logs");
  });

  it("builds daily summaries from rollups and reconciled data", async () => {
    const r = await callTool("get_daily_summaries", { startDate: "2026-09-27", endDate: "2026-09-28" });
    expect(r.isError).toBe(false);
    const day28 = r.data.days.find((d: any) => d.date === "2026-09-28");
    expect(day28.restingHeartRate).toBe(56);
    const day27 = r.data.days.find((d: any) => d.date === "2026-09-27");
    expect(day27).toMatchObject({ steps: 10500, totalKcal: 2500, intakeKcal: 2000, proteinG: 140, weightKg: 82 });
  });

  it("stores goals and reports progress", async () => {
    const set = await callTool("set_goals", { dailySteps: 10000, dailyCaloriesKcal: 2100, targetWeightKg: 78 });
    expect(set.data.goals).toMatchObject({ dailySteps: 10000, targetWeightKg: 78 });
    const cleared = await callTool("set_goals", { targetWeightKg: null });
    expect(cleared.data.goals.targetWeightKg).toBeUndefined();

    const p = await callTool("get_goal_progress", { days: 7, endDate: "2026-09-28" });
    expect(p.isError).toBe(false);
    expect(p.data.goalsSet).toBe(true);
    expect(p.data.targets.dailySteps.target).toBe(10000);
    expect(p.data.energyBalance.daysWithIntakeAndBurn).toBeGreaterThan(0);
  });

  it("lists nutrition logs with their source", async () => {
    const r = await callTool("get_nutrition_logs", { startDate: "2026-09-28", endDate: "2026-09-28" });
    expect(r.data.days[0].meals[0]).toMatchObject({ name: "Oats", kcal: 350, source: "HEALTH_KIT · com.myfitnesspal" });
  });

  it("logs a meal with the right payload", async () => {
    writes.length = 0;
    const r = await callTool("log_meal", {
      name: "Chicken rice bowl",
      kcal: 620,
      proteinG: 45,
      carbsG: 70,
      fatG: 15,
      sodiumMg: 800,
      mealType: "LUNCH",
      time: "2026-09-28T13:00",
    });
    expect(r.isError).toBe(false);
    expect(r.data.logged.id).toBe("users/hu-1/dataTypes/nutrition-log/dataPoints/new-1");
    const sent = writes[0].body;
    expect(writes[0].path).toBe("/v4/users/me/dataTypes/nutrition-log/dataPoints");
    expect(sent.nutritionLog.interval).toMatchObject({ startTime: "2026-09-28T11:00:00.000Z", startUtcOffset: "7200s" });
    expect(sent.nutritionLog.totalCarbohydrate).toEqual({ grams: 70 });
    expect(sent.nutritionLog.nutrients).toContainEqual({ nutrient: "SODIUM", quantity: { grams: 0.8 } });
  });

  it("logs weight in pounds as grams", async () => {
    writes.length = 0;
    const r = await callTool("log_body_measurement", { weight: 180, weightUnit: "lb", time: "2026-09-28T07:00" });
    expect(r.isError).toBe(false);
    expect(writes[0].body.weight.weightGrams).toBe(81647);
  });

  it("deletes entries via batchDelete with users/me names", async () => {
    writes.length = 0;
    const r = await callTool("delete_entries", { ids: ["users/hu-1/dataTypes/weight/dataPoints/new-1"] });
    expect(r.data.deleted).toEqual({ weight: 1 });
    expect(writes[0]).toEqual({
      path: "/v4/users/me/dataTypes/weight/dataPoints:batchDelete",
      body: { names: ["users/me/dataTypes/weight/dataPoints/new-1"] },
    });
  });

  it("returns tool errors for bad input instead of failing the request", async () => {
    const r = await callTool("get_daily_summaries", { startDate: "2026-01-01", endDate: "2026-09-28" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/too long/);
  });

  it("revokes tokens", async () => {
    const res = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ token: accessToken, client_id: clientId }),
    });
    expect(res.status).toBe(200);
    expect((await mcp("tools/list")).status).toBe(401);
  });
});
