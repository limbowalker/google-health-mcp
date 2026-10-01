import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DATA_SOURCE_FAMILIES, type Json } from "../../health/client.js";
import { civilRangeFilter, DATA_TYPES, getDataType, readScope, typesWith } from "../../health/datatypes.js";
import {
  clean,
  compactPoint,
  num,
  rollupDate,
  round,
  simplifyRollup,
  summarizeExercise,
  summarizeNutritionLog,
  summarizeSleep,
} from "../../health/summarize.js";
import { addDays, formatLocal, fromCivil, parseDateTime, resolveRange, todayIn } from "../../health/time.js";
import { requireScope, runTool, UserInputError, withConcurrency, type ToolContext } from "../context.js";
import { averages } from "../goals.js";
import { buildDailySummaries, SUMMARY_GROUPS } from "../summaries.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const dateArg = (what: string) => z.string().optional().describe(`${what} (YYYY-MM-DD, user's local date)`);
const familyArg = z
  .enum(DATA_SOURCE_FAMILIES as [string, ...string[]])
  .optional()
  .describe(
    "Which sources to include. all-sources (default) includes Fitbit/Pixel devices, manual entries and third-party data " +
      "such as Apple Health and Health Connect; google-wearables = Fitbit/Pixel devices only; google-sources = first-party " +
      "Google data plus Health Connect; self-sources = only entries written by this server",
  );
const modeArg = z
  .enum(["reconciled", "raw"])
  .optional()
  .describe("reconciled = deduplicated across sources (default); raw = every stored entry with its source (e.g. HEALTH_KIT for Apple Health)");

const SCOPE_LABELS: Record<string, string> = {
  activity_and_fitness: "activity, workouts and energy",
  health_metrics_and_measurements: "heart, body composition and vitals",
  sleep: "sleep",
  nutrition: "food and water logs",
  profile: "profile",
  settings: "units, timezone and devices",
};

function unit(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/^[A-Z]+_UNIT_/, "").toLowerCase() : undefined;
}

export function registerReadTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "get_user_context",
    {
      title: "Get user context",
      description:
        "Call this first. Returns today's date and timezone, the user's preferred units, profile (age, stride), paired " +
        "Fitbit/Pixel devices with last sync time, which data permissions were granted, and the user's coaching goals.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      runTool(async () => {
        const [settings, profile, devices, user] = await Promise.all([
          ctx.settings(),
          ctx.scopes.has("profile.readonly") ? ctx.health.getProfile().catch(() => undefined) : undefined,
          ctx.scopes.has("settings.readonly") ? ctx.health.listPairedDevices().catch(() => undefined) : undefined,
          ctx.store.getUser(ctx.userId),
        ]);
        const tz = await ctx.timeZone();
        const granted = (suffix: string) =>
          Object.keys(SCOPE_LABELS).filter((g) => ctx.scopes.has(`${g}.${suffix}`)).map((g) => SCOPE_LABELS[g]);
        const cm = (mm: unknown) => (num(mm) !== undefined ? round(num(mm)! / 10, 1) : undefined);
        return clean({
          today: todayIn(tz),
          timeZone: tz,
          timeZoneSource: settings?.timeZone ? "Google Health settings" : "default; settings not readable",
          preferredUnits: settings
            ? clean({
                weight: unit(settings.weightUnit),
                distance: unit(settings.distanceUnit),
                height: unit(settings.heightUnit),
                water: unit(settings.waterUnit),
                swim: unit(settings.swimUnit),
                temperature: unit(settings.temperatureUnit),
                glucose: unit(settings.glucoseUnit),
              })
            : undefined,
          profile: profile
            ? clean({
                age: num(profile.age),
                memberSince: fromCivil(profile.membershipStartDate),
                walkingStrideCm: cm(profile.userConfiguredWalkingStrideLengthMm ?? profile.autoWalkingStrideLengthMm),
                runningStrideCm: cm(profile.userConfiguredRunningStrideLengthMm ?? profile.autoRunningStrideLengthMm),
              })
            : undefined,
          devices: (devices?.pairedDevices as Json[] | undefined)?.map((d) =>
            clean({ model: d.deviceVersion, type: d.deviceType, battery: d.batteryStatus, lastSync: d.lastSyncTime }),
          ),
          permissions: {
            read: granted("readonly"),
            write: granted("writeonly"),
            notGranted: Object.keys(SCOPE_LABELS)
              .filter((g) => !ctx.scopes.has(`${g}.readonly`))
              .map((g) => SCOPE_LABELS[g]),
          },
          goals: user?.goals ?? null,
          notes: [
            "All tool outputs use metric units (kg, km, kcal, g, ml, minutes); convert to preferredUnits when talking to the user.",
            "Data from all sources synced into Google Health (Fitbit, Pixel Watch, manual entries, Apple Health, Health Connect) is included and reconciled by default.",
            "Goals are stored by this server (the Google Health API has no goals endpoint); use set_goals to change them.",
          ],
        });
      }),
  );

  server.registerTool(
    "get_daily_summaries",
    {
      title: "Daily summaries",
      description:
        "One row per day with steps, distance, total and active calories, Active Zone Minutes, resting heart rate, HRV, " +
        "sleep minutes and efficiency, weight, body fat, calories and macros eaten, water, and workout count/minutes, plus " +
        "averages. Best starting point for trend analysis. Up to 90 days; defaults to the last 14 days including today " +
        "(today is partial).",
      inputSchema: {
        startDate: dateArg("First day"),
        endDate: dateArg("Last day, inclusive; defaults to today"),
        groups: z
          .array(z.enum(SUMMARY_GROUPS))
          .optional()
          .describe("Limit to these metric groups to save time; default all"),
      },
      annotations: READ_ONLY,
    },
    ({ startDate, endDate, groups }) =>
      runTool(async () => {
        const tz = await ctx.timeZone();
        const range = resolveRange({ startDate, endDate }, tz, 14, 90);
        const result = await buildDailySummaries(ctx, range, groups ?? SUMMARY_GROUPS);
        return {
          timeZone: tz,
          start: range.start,
          end: range.end,
          averages: averages(result.days),
          days: result.days,
          ...(result.unavailable ? { unavailable: result.unavailable } : {}),
        };
      }),
  );

  const rollupTypes = typesWith("dailyRollUp");
  server.registerTool(
    "get_metric_series",
    {
      title: "Metric time series",
      description:
        "Aggregated time series for one metric: per day or week (local dates), or intraday buckets (hour, 30min, 15min, " +
        "5min, 1min). Use for charts and intraday analysis, e.g. heart rate by hour or steps by 15 minutes. " +
        "Day/week ranges go up to 366 days. Intraday output is capped at 1500 buckets, and intraday ranges for " +
        "heart-rate, total-calories, active-minutes and calories-in-heart-rate-zone are limited to 14 days.",
      inputSchema: {
        dataType: z.enum(rollupTypes as [string, ...string[]]).describe("Metric to aggregate"),
        startDate: dateArg("First day"),
        endDate: dateArg("Last day, inclusive; defaults to today"),
        granularity: z.enum(["day", "week", "hour", "30min", "15min", "5min", "1min"]).optional().describe("Default: day"),
        dataSourceFamily: familyArg,
      },
      annotations: READ_ONLY,
    },
    ({ dataType, startDate, endDate, granularity = "day", dataSourceFamily }) =>
      runTool(async () => {
        const info = getDataType(dataType);
        requireScope(ctx, readScope(info), info.description.toLowerCase());
        const tz = await ctx.timeZone();
        const family = (dataSourceFamily ?? "all-sources") as (typeof DATA_SOURCE_FAMILIES)[number];

        if (granularity === "day" || granularity === "week") {
          const range = resolveRange({ startDate, endDate }, tz, granularity === "week" ? 84 : 30, 366);
          const points = await ctx.health.dailyRollUp(dataType, range.start, range.endExclusive, family);
          const daily = points
            .map((p) => ({ date: rollupDate(p)!, ...simplifyRollup(dataType, p) }))
            .filter((p) => p.date)
            .sort((a, b) => a.date.localeCompare(b.date));
          const series = granularity === "day" ? daily : toWeeks(daily, range.start, isAdditive(dataType));
          return { dataType, granularity, timeZone: tz, start: range.start, end: range.end, series };
        }

        const windowSec = { hour: 3600, "30min": 1800, "15min": 900, "5min": 300, "1min": 60 }[granularity];
        if (info.resolutionSec && windowSec < info.resolutionSec) {
          throw new UserInputError(`${dataType} is stored at ${info.resolutionSec}s resolution; use a coarser granularity`);
        }
        const range = resolveRange({ startDate, endDate }, tz, 1, info.maxRollupDays);
        const buckets = (range.days * 86400) / windowSec;
        if (buckets > 1500) {
          throw new UserInputError(`That would return ${buckets} buckets; shorten the range or use a coarser granularity (max 1500).`);
        }
        const startTime = parseDateTime(range.start, tz).toISOString();
        const endTime = parseDateTime(range.endExclusive, tz).toISOString();
        const points = await ctx.health.rollUp(dataType, { startTime, endTime, windowSec, family });
        const series = points
          .map((p) => ({ start: formatLocal(new Date(p.startTime), tz), ...simplifyRollup(dataType, p) }))
          .filter((p) => Object.keys(p).length > 1)
          .sort((a, b) => a.start.localeCompare(b.start));
        return { dataType, granularity, timeZone: tz, start: range.start, end: range.end, series };
      }),
  );

  const listTypes = DATA_TYPES.filter((t) => t.ops.includes("list") || t.ops.includes("reconcile")).map((t) => t.id);
  server.registerTool(
    "list_data_points",
    {
      title: "List data points",
      description:
        "Individual stored data points for any data type, newest first, with their ids (needed for delete_entries) and, in " +
        "raw mode, their source (e.g. 'HEALTH_KIT · Apple Watch'). Use for detail the summary tools don't give. " +
        "High-frequency types (heart-rate, steps) produce many points; prefer get_metric_series for aggregates.",
      inputSchema: {
        dataType: z.enum(listTypes as [string, ...string[]]),
        startDate: dateArg("First day; default 7 days ago"),
        endDate: dateArg("Last day, inclusive; default today"),
        mode: modeArg,
        dataSourceFamily: familyArg.describe("Only for reconciled mode; see get_metric_series"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max points to return (default 100)"),
        pageToken: z.string().optional().describe("nextPageToken from a previous call to continue"),
      },
      annotations: READ_ONLY,
    },
    ({ dataType, startDate, endDate, mode, dataSourceFamily, limit = 100, pageToken }) =>
      runTool(async () => {
        const info = getDataType(dataType);
        requireScope(ctx, readScope(info), info.description.toLowerCase());
        const tz = await ctx.timeZone();
        const range = resolveRange({ startDate, endDate }, tz, 7, 366);
        let apiMode: "list" | "reconcile" = mode === "raw" ? "list" : "reconcile";
        if (!info.ops.includes(apiMode)) apiMode = info.ops.includes("list") ? "list" : "reconcile";
        const filter = civilRangeFilter(info, range.start, range.endExclusive);
        const points: Json[] = [];
        let token = pageToken;
        do {
          const page = await ctx.health.page(apiMode, dataType, {
            filter,
            pageToken: token,
            pageSize: Math.min(limit - points.length, info.kind === "session" ? 25 : 1000),
            family: dataSourceFamily as (typeof DATA_SOURCE_FAMILIES)[number] | undefined,
          });
          points.push(...page.dataPoints);
          token = page.nextPageToken;
        } while (token && points.length < limit);
        return clean({
          dataType,
          mode: apiMode === "list" ? "raw" : "reconciled",
          timeZone: tz,
          start: range.start,
          end: range.end,
          count: points.length,
          points: points.map((p) => compactPoint(p, info)),
          nextPageToken: token,
        });
      }),
  );

  server.registerTool(
    "get_workouts",
    {
      title: "Workouts",
      description:
        "Workout sessions with type, duration, distance, calories, average heart rate, Active Zone Minutes, pace and " +
        "heart-rate-zone minutes, plus totals by type. Defaults to the last 30 days (max 366).",
      inputSchema: {
        startDate: dateArg("First day"),
        endDate: dateArg("Last day, inclusive"),
        mode: modeArg,
        limit: z.number().int().min(1).max(300).optional().describe("Max workouts (default 100)"),
      },
      annotations: READ_ONLY,
    },
    ({ startDate, endDate, mode, limit = 100 }) =>
      runTool(async () => {
        requireScope(ctx, "activity_and_fitness.readonly", "activity and workouts");
        const tz = await ctx.timeZone();
        const range = resolveRange({ startDate, endDate }, tz, 30, 366);
        const info = getDataType("exercise");
        const { dataPoints, truncated } = await ctx.health.collect(
          mode === "raw" ? "list" : "reconcile",
          "exercise",
          { filter: civilRangeFilter(info, range.start, range.endExclusive), family: mode === "raw" ? undefined : "all-sources" },
          limit,
        );
        const workouts = dataPoints.map(summarizeExercise);
        const byType: Record<string, { count: number; minutes: number; kcal: number; km: number }> = {};
        for (const w of workouts) {
          const t = (byType[w.type ?? "UNKNOWN"] ??= { count: 0, minutes: 0, kcal: 0, km: 0 });
          t.count++;
          t.minutes += w.durationMin ?? 0;
          t.kcal += w.kcal ?? 0;
          t.km = round(t.km + (w.distanceKm ?? 0), 2)!;
        }
        return { timeZone: tz, start: range.start, end: range.end, count: workouts.length, truncated, byType, workouts };
      }),
  );

  server.registerTool(
    "get_sleep_sessions",
    {
      title: "Sleep sessions",
      description:
        "Sleep sessions (including naps) with time asleep, awake, efficiency, time to fall asleep and minutes per stage " +
        "(deep, light, REM, awake). Sessions are dated by wake-up day. Defaults to the last 14 days (max 366).",
      inputSchema: {
        startDate: dateArg("First wake-up day"),
        endDate: dateArg("Last wake-up day, inclusive"),
        mode: modeArg,
        limit: z.number().int().min(1).max(300).optional().describe("Max sessions (default 100)"),
      },
      annotations: READ_ONLY,
    },
    ({ startDate, endDate, mode, limit = 100 }) =>
      runTool(async () => {
        requireScope(ctx, "sleep.readonly", "sleep");
        const tz = await ctx.timeZone();
        const range = resolveRange({ startDate, endDate }, tz, 14, 366);
        const { dataPoints, truncated } = await ctx.health.collect(
          mode === "raw" ? "list" : "reconcile",
          "sleep",
          {
            filter: civilRangeFilter(getDataType("sleep"), range.start, range.endExclusive),
            family: mode === "raw" ? undefined : "all-sources",
          },
          limit,
        );
        const sessions = dataPoints.map(summarizeSleep);
        const main = sessions.filter((s) => s.mainSleep !== false && !s.nap);
        const avg = (key: string) => {
          const xs = main.map((s) => s[key]).filter((v): v is number => typeof v === "number");
          return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 0) : undefined;
        };
        return {
          timeZone: tz,
          start: range.start,
          end: range.end,
          count: sessions.length,
          truncated,
          mainSleepAverages: clean({
            minutesAsleep: avg("minutesAsleep"),
            efficiencyPct: avg("efficiencyPct"),
            minutesToFallAsleep: avg("minutesToFallAsleep"),
          }),
          sessions,
        };
      }),
  );

  server.registerTool(
    "get_nutrition_logs",
    {
      title: "Food and water logs",
      description:
        "Logged meals (calories, protein, carbs, fat, fiber, sugar, sodium) and water, grouped by day with daily totals " +
        "and entry ids. Defaults to the last 7 days (max 90). Entries synced from other apps via Apple Health or Health " +
        "Connect appear with their source.",
      inputSchema: {
        startDate: dateArg("First day"),
        endDate: dateArg("Last day, inclusive"),
      },
      annotations: READ_ONLY,
    },
    ({ startDate, endDate }) =>
      runTool(async () => {
        requireScope(ctx, "nutrition.readonly", "food and water logs");
        const tz = await ctx.timeZone();
        const range = resolveRange({ startDate, endDate }, tz, 7, 90);
        const [meals, water] = await Promise.all(
          ["nutrition-log", "hydration-log"].map((type) =>
            ctx.health.collect("list", type, { filter: civilRangeFilter(getDataType(type), range.start, range.endExclusive) }, 2000),
          ),
        );
        const days = new Map<string, { date: string; totals: Json; meals: Json[]; water: Json[] }>();
        const day = (date: string) => {
          let d = days.get(date);
          if (!d) days.set(date, (d = { date, totals: {}, meals: [], water: [] }));
          return d;
        };
        const add = (totals: Json, key: string, v: number | undefined) => {
          if (v !== undefined) totals[key] = round((totals[key] ?? 0) + v, 1);
        };
        for (const p of meals.dataPoints) {
          const m = summarizeNutritionLog(p);
          if (!m.date) continue;
          const d = day(m.date);
          d.meals.push(m);
          for (const k of ["kcal", "proteinG", "carbsG", "fatG", "fiberG", "sugarG", "sodiumMg"]) add(d.totals, k, m[k]);
        }
        for (const p of water.dataPoints) {
          const w = compactPoint(p, getDataType("hydration-log"));
          const date = typeof w.interval?.start === "string" ? w.interval.start.slice(0, 10) : undefined;
          if (!date) continue;
          const ml = num(p.hydrationLog?.amountConsumed?.milliliters);
          day(date).water.push(clean({ id: w.id, time: w.interval.start, ml, source: w.source }));
          add(day(date).totals, "waterMl", ml);
        }
        return {
          timeZone: tz,
          start: range.start,
          end: range.end,
          truncated: meals.truncated || water.truncated,
          days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
        };
      }),
  );

  server.registerTool(
    "check_data_sources",
    {
      title: "Check data sources",
      description:
        "Shows which platforms and devices recently contributed data per type (e.g. FITBIT, HEALTH_KIT for Apple Health, " +
        "HEALTH_CONNECT, GOOGLE_WEB_API for entries written by this server). Use to verify that Apple Health or other " +
        "sync works, or to explain gaps.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      runTool(async () => {
        const tz = await ctx.timeZone();
        const today = todayIn(tz);
        const probes: { type: string; days: number; max: number }[] = [
          { type: "steps", days: 2, max: 3000 },
          { type: "heart-rate", days: 1, max: 3000 },
          { type: "exercise", days: 30, max: 100 },
          { type: "sleep", days: 14, max: 50 },
          { type: "daily-resting-heart-rate", days: 14, max: 100 },
          { type: "weight", days: 90, max: 500 },
          { type: "body-fat", days: 90, max: 500 },
          { type: "nutrition-log", days: 14, max: 1000 },
          { type: "hydration-log", days: 14, max: 1000 },
        ].filter((p) => ctx.scopes.has(readScope(getDataType(p.type))));

        const platforms = new Set<string>();
        const results = await withConcurrency(3, probes.map((probe) => async () => {
          const info = getDataType(probe.type);
          try {
            const { dataPoints, truncated } = await ctx.health.collect(
              "list",
              probe.type,
              { filter: civilRangeFilter(info, addDays(today, -(probe.days - 1)), addDays(today, 1)), pageSize: 1000 },
              probe.max,
            );
            const sources: Record<string, number> = {};
            for (const p of dataPoints) {
              const ds = p.dataSource ?? {};
              if (ds.platform) platforms.add(ds.platform);
              const label = [ds.platform ?? "UNKNOWN", ds.device?.displayName, ds.application?.packageName].filter(Boolean).join(" · ");
              sources[label] = (sources[label] ?? 0) + 1;
            }
            return [probe.type, clean({ window: `last ${probe.days} day(s)`, points: dataPoints.length, sampled: truncated || undefined, sources })];
          } catch (err) {
            return [probe.type, { error: err instanceof Error ? err.message : String(err) }];
          }
        }));
        return {
          byDataType: Object.fromEntries(results),
          platformsSeen: [...platforms],
          appleHealthDetected: platforms.has("HEALTH_KIT"),
          hint: platforms.has("HEALTH_KIT")
            ? "Apple Health data is reaching Google Health."
            : "No Apple Health (HEALTH_KIT) data found in these windows. If the user expects it, they should check Apple Health sync in the Google Health app on their iPhone.",
        };
      }),
  );
}

const ADDITIVE = new Set([
  "steps", "distance", "floors", "altitude", "total-calories", "active-energy-burned", "active-zone-minutes",
  "active-minutes", "sedentary-period", "time-in-heart-rate-zone", "calories-in-heart-rate-zone", "nutrition-log",
  "hydration-log", "swim-lengths-data",
]);

function isAdditive(type: string) {
  return ADDITIVE.has(type);
}

/** Groups daily points into 7-day buckets starting at `start`: totals for additive metrics, means otherwise. */
function toWeeks(daily: Json[], start: string, additive: boolean): Json[] {
  const weeks = new Map<string, Json[]>();
  for (const d of daily) {
    let weekStart = start;
    while (addDays(weekStart, 7) <= d.date) weekStart = addDays(weekStart, 7);
    (weeks.get(weekStart) ?? weeks.set(weekStart, []).get(weekStart)!).push(d);
  }
  return [...weeks.entries()].map(([weekStart, days]) => {
    const keys = new Set(days.flatMap((d) => Object.keys(d).filter((k) => k !== "date")));
    const out: Json = { weekStart, daysWithData: days.length };
    for (const key of keys) {
      const xs = days.map((d) => d[key]).filter((v): v is number => typeof v === "number");
      if (!xs.length) continue;
      if (additive) {
        out[key] = round(xs.reduce((a, b) => a + b, 0), 2);
        out[`${key}DailyAvg`] = round(xs.reduce((a, b) => a + b, 0) / xs.length, 1);
      } else if (/^min/.test(key)) out[key] = Math.min(...xs);
      else if (/^max/.test(key)) out[key] = Math.max(...xs);
      else out[key] = round(xs.reduce((a, b) => a + b, 0) / xs.length, 2);
    }
    return out;
  });
}
